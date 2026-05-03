import { MetadataContext } from "../../src/metadata/MetadataContext";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";

describe("MetadataContext (AsyncLocalStorage)", () => {
  beforeEach(() => {
    MetadataContext.reset();
    MetadataLayerRegistry.reset();
  });

  it("should return 'public' when no context is active", () => {
    expect(MetadataContext.getCurrentTenant()).toBe("public");
    expect(MetadataContext.isActive()).toBe(false);
  });

  it("should set tenant within run()", async () => {
    await MetadataContext.run("tenant_1", async () => {
      expect(MetadataContext.getCurrentTenant()).toBe("tenant_1");
      expect(MetadataContext.isActive()).toBe(true);
    });

    // run() 밖에서는 다시 기본값
    expect(MetadataContext.getCurrentTenant()).toBe("public");
  });

  it("should support nested contexts", async () => {
    await MetadataContext.run("tenant_1", async () => {
      expect(MetadataContext.getCurrentTenant()).toBe("tenant_1");

      await MetadataContext.run("tenant_2", async () => {
        expect(MetadataContext.getCurrentTenant()).toBe("tenant_2");
      });

      // 내부 컨텍스트가 끝나면 외부로 복원
      expect(MetadataContext.getCurrentTenant()).toBe("tenant_1");
    });
  });

  it("should isolate concurrent async operations", async () => {
    const results: string[] = [];

    await Promise.all([
      MetadataContext.run("tenant_a", async () => {
        await delay(10);
        results.push(`a:${MetadataContext.getCurrentTenant()}`);
      }),
      MetadataContext.run("tenant_b", async () => {
        await delay(5);
        results.push(`b:${MetadataContext.getCurrentTenant()}`);
      }),
    ]);

    expect(results).toContain("a:tenant_a");
    expect(results).toContain("b:tenant_b");
  });
});

describe("MetadataContext deeply nested run() (3+ levels)", () => {
  beforeEach(() => {
    MetadataContext.reset();
    MetadataLayerRegistry.reset();
  });

  it("should propagate and restore tenant across 3-level nesting", async () => {
    const trail: string[] = [];

    await MetadataContext.run("t1", async () => {
      trail.push(`L1:${MetadataContext.getCurrentTenant()}`);

      await MetadataContext.run("t2", async () => {
        trail.push(`L2:${MetadataContext.getCurrentTenant()}`);

        await MetadataContext.run("t3", async () => {
          trail.push(`L3:${MetadataContext.getCurrentTenant()}`);
        });

        // L3 종료 후 L2 컨텍스트 복원
        trail.push(`L2-after:${MetadataContext.getCurrentTenant()}`);
      });

      // L2 종료 후 L1 컨텍스트 복원
      trail.push(`L1-after:${MetadataContext.getCurrentTenant()}`);
    });

    // run() 모두 종료 후 public
    trail.push(`root:${MetadataContext.getCurrentTenant()}`);

    expect(trail).toEqual([
      "L1:t1",
      "L2:t2",
      "L3:t3",
      "L2-after:t2",
      "L1-after:t1",
      "root:public",
    ]);
  });

  it("should propagate and restore tenant across 4-level nesting", async () => {
    const trail: string[] = [];

    await MetadataContext.run("t1", async () => {
      trail.push(`L1:${MetadataContext.getCurrentTenant()}`);

      await MetadataContext.run("t2", async () => {
        trail.push(`L2:${MetadataContext.getCurrentTenant()}`);

        await MetadataContext.run("t3", async () => {
          trail.push(`L3:${MetadataContext.getCurrentTenant()}`);

          await MetadataContext.run("t4", async () => {
            trail.push(`L4:${MetadataContext.getCurrentTenant()}`);
            expect(MetadataContext.isActive()).toBe(true);
          });

          trail.push(`L3-after:${MetadataContext.getCurrentTenant()}`);
        });

        trail.push(`L2-after:${MetadataContext.getCurrentTenant()}`);
      });

      trail.push(`L1-after:${MetadataContext.getCurrentTenant()}`);
    });

    trail.push(`root:${MetadataContext.getCurrentTenant()}`);
    expect(MetadataContext.isActive()).toBe(false);

    expect(trail).toEqual([
      "L1:t1",
      "L2:t2",
      "L3:t3",
      "L4:t4",
      "L3-after:t3",
      "L2-after:t2",
      "L1-after:t1",
      "root:public",
    ]);
  });

  it("should restore parent tenant even when same tenantId is reused at deeper level", async () => {
    // 동일 tenant id 재사용 시에도 별도 store 인스턴스로 복원되어야 함
    await MetadataContext.run("dup", async () => {
      expect(MetadataContext.getCurrentTenant()).toBe("dup");

      await MetadataContext.run("dup", async () => {
        expect(MetadataContext.getCurrentTenant()).toBe("dup");

        await MetadataContext.run("dup", async () => {
          expect(MetadataContext.getCurrentTenant()).toBe("dup");
        });

        expect(MetadataContext.getCurrentTenant()).toBe("dup");
      });

      expect(MetadataContext.getCurrentTenant()).toBe("dup");
    });

    expect(MetadataContext.getCurrentTenant()).toBe("public");
  });

  it("should restore outer context when inner level throws (3-level)", async () => {
    const seen: string[] = [];

    await MetadataContext.run("outer", async () => {
      seen.push(MetadataContext.getCurrentTenant());

      try {
        await MetadataContext.run("middle", async () => {
          seen.push(MetadataContext.getCurrentTenant());

          await MetadataContext.run("inner", async () => {
            seen.push(MetadataContext.getCurrentTenant());
            throw new Error("boom");
          });
        });
      } catch (err) {
        seen.push(`caught:${(err as Error).message}`);
      }

      // inner/middle 가 throw 했어도 outer 복원되어야 함
      seen.push(`recovered:${MetadataContext.getCurrentTenant()}`);
    });

    expect(seen).toEqual([
      "outer",
      "middle",
      "inner",
      "caught:boom",
      "recovered:outer",
    ]);
    expect(MetadataContext.getCurrentTenant()).toBe("public");
  });

  it("should keep each level isolated when 4-level chains run concurrently", async () => {
    // 두 개의 4중 체인을 동시에 실행해도 서로 간섭이 없어야 함
    const buildChain = async (
      prefix: string,
      delayMs: number,
    ): Promise<string[]> => {
      const trail: string[] = [];
      await MetadataContext.run(`${prefix}_1`, async () => {
        await delay(delayMs);
        trail.push(MetadataContext.getCurrentTenant());

        await MetadataContext.run(`${prefix}_2`, async () => {
          await delay(delayMs);
          trail.push(MetadataContext.getCurrentTenant());

          await MetadataContext.run(`${prefix}_3`, async () => {
            await delay(delayMs);
            trail.push(MetadataContext.getCurrentTenant());

            await MetadataContext.run(`${prefix}_4`, async () => {
              await delay(delayMs);
              trail.push(MetadataContext.getCurrentTenant());
            });

            trail.push(MetadataContext.getCurrentTenant());
          });

          trail.push(MetadataContext.getCurrentTenant());
        });

        trail.push(MetadataContext.getCurrentTenant());
      });
      return trail;
    };

    const [a, b] = await Promise.all([
      buildChain("a", 3),
      buildChain("b", 7),
    ]);

    expect(a).toEqual(["a_1", "a_2", "a_3", "a_4", "a_3", "a_2", "a_1"]);
    expect(b).toEqual(["b_1", "b_2", "b_3", "b_4", "b_3", "b_2", "b_1"]);
  });

  it("should mix run() and runUnscoped() across 4 levels without losing tenant", async () => {
    // run → runUnscoped → run → runUnscoped 4중 체인
    await MetadataContext.run("tenant_x", async () => {
      expect(MetadataContext.getCurrentTenant()).toBe("tenant_x");
      expect(MetadataContext.isUnscoped()).toBe(false);

      await MetadataContext.runUnscoped(async () => {
        // unscoped 는 부모 tenantId 를 보존
        expect(MetadataContext.getCurrentTenant()).toBe("tenant_x");
        expect(MetadataContext.isUnscoped()).toBe(true);

        await MetadataContext.run("tenant_y", async () => {
          // 새 run() 안에서는 unscoped 가 다시 false
          expect(MetadataContext.getCurrentTenant()).toBe("tenant_y");
          expect(MetadataContext.isUnscoped()).toBe(false);

          await MetadataContext.runUnscoped(async () => {
            // 가장 안쪽: tenant_y 보존 + unscoped true
            expect(MetadataContext.getCurrentTenant()).toBe("tenant_y");
            expect(MetadataContext.isUnscoped()).toBe(true);
          });

          // L4 종료 후 L3 (run tenant_y, scoped) 복원
          expect(MetadataContext.getCurrentTenant()).toBe("tenant_y");
          expect(MetadataContext.isUnscoped()).toBe(false);
        });

        // L3 종료 후 L2 (unscoped on tenant_x) 복원
        expect(MetadataContext.getCurrentTenant()).toBe("tenant_x");
        expect(MetadataContext.isUnscoped()).toBe(true);
      });

      // L2 종료 후 L1 (run tenant_x, scoped) 복원
      expect(MetadataContext.getCurrentTenant()).toBe("tenant_x");
      expect(MetadataContext.isUnscoped()).toBe(false);
    });

    // 모두 종료 후 public + scoped
    expect(MetadataContext.getCurrentTenant()).toBe("public");
    expect(MetadataContext.isUnscoped()).toBe(false);
    expect(MetadataContext.isActive()).toBe(false);
  });

  it("should keep nested contexts intact across awaited microtasks and timers", async () => {
    // 비동기 await/setImmediate/setTimeout 경계를 넘어도 컨텍스트 유지
    await MetadataContext.run("t_root", async () => {
      await Promise.resolve();
      expect(MetadataContext.getCurrentTenant()).toBe("t_root");

      await MetadataContext.run("t_mid", async () => {
        await new Promise<void>((r) => setImmediate(r));
        expect(MetadataContext.getCurrentTenant()).toBe("t_mid");

        await MetadataContext.run("t_leaf", async () => {
          await delay(2);
          await Promise.resolve();
          expect(MetadataContext.getCurrentTenant()).toBe("t_leaf");
        });

        await delay(2);
        expect(MetadataContext.getCurrentTenant()).toBe("t_mid");
      });

      await Promise.resolve();
      expect(MetadataContext.getCurrentTenant()).toBe("t_root");
    });

    expect(MetadataContext.getCurrentTenant()).toBe("public");
  });
});

describe("MetadataLayerRegistry + MetadataContext 통합", () => {
  beforeEach(() => {
    MetadataContext.reset();
    MetadataLayerRegistry.reset();
  });

  it("should use AsyncLocalStorage tenant in MetadataLayerRegistry", async () => {
    const registry = MetadataLayerRegistry.getInstance();

    // public에 데이터 저장
    registry.getCurrentLayer().set("entities::User", { name: "User_public" });

    // tenant_1 레이어 생성 및 데이터 저장
    registry.setContext("tenant_1");
    registry.getCurrentLayer().set("entities::User", { name: "User_T1" });
    registry.setContext("public"); // 수동 컨텍스트 복원

    // AsyncLocalStorage를 통해 tenant_1 컨텍스트에서 읽기
    await MetadataContext.run("tenant_1", async () => {
      expect(registry.getContext()).toBe("tenant_1");
      const value = registry.resolveValue<any>("entities::User");
      expect(value).toEqual({ name: "User_T1" });
    });

    // run() 밖에서는 public으로 복원
    expect(registry.getContext()).toBe("public");
    const publicValue = registry.resolveValue<any>("entities::User");
    expect(publicValue).toEqual({ name: "User_public" });
  });

  it("should fallback to public layer when tenant layer has no data", async () => {
    const registry = MetadataLayerRegistry.getInstance();

    // public에만 데이터 저장
    registry.getCurrentLayer().set("entities::Post", { name: "Post_public" });

    // tenant_2 레이어 생성 (데이터 없음)
    registry.setContext("tenant_2");
    registry.setContext("public");

    await MetadataContext.run("tenant_2", async () => {
      // tenant_2에 데이터가 없으므로 public fallback
      const value = registry.resolveValue<any>("entities::Post");
      expect(value).toEqual({ name: "Post_public" });
    });
  });

  it("should override public data with tenant-specific data", async () => {
    const registry = MetadataLayerRegistry.getInstance();

    // public 베이스 데이터
    registry
      .getCurrentLayer()
      .set("entities::Cat", { name: "Cat", columns: ["id", "name"] });

    // tenant_3에서 스키마 확장
    registry.setContext("tenant_3");
    registry
      .getCurrentLayer()
      .set("entities::Cat", { name: "Cat", columns: ["id", "name", "breed"] });
    registry.setContext("public");

    // public에서 읽기 — 원본 유지
    const publicCat = registry.resolveValue<any>("entities::Cat");
    expect(publicCat.columns).toHaveLength(2);

    // tenant_3에서 읽기 — 확장된 스키마
    await MetadataContext.run("tenant_3", async () => {
      const tenantCat = registry.resolveValue<any>("entities::Cat");
      expect(tenantCat.columns).toHaveLength(3);
      expect(tenantCat.columns).toContain("breed");
    });
  });

  it("should prioritize AsyncLocalStorage over manual setContext", async () => {
    const registry = MetadataLayerRegistry.getInstance();

    registry.setContext("manual_tenant");

    await MetadataContext.run("async_tenant", async () => {
      // AsyncLocalStorage가 setContext보다 우선
      expect(registry.getContext()).toBe("async_tenant");
    });

    // run() 밖에서는 수동 설정값으로 복귀
    expect(registry.getContext()).toBe("manual_tenant");
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
