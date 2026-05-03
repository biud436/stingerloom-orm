import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 순수 Node.js AsyncLocalStorage 동작 검증.
 * MetadataContext 등 ORM 래퍼와 무관하게 ALS 자체의
 * 중첩 push/pop, 동시 실행 격리, 비동기 경계 보존 시맨틱을 확인한다.
 */

interface Store {
  id: string;
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("AsyncLocalStorage — baseline", () => {
  it("returns undefined outside any run()", () => {
    const als = new AsyncLocalStorage<Store>();
    expect(als.getStore()).toBeUndefined();
  });

  it("exposes the store synchronously inside run()", () => {
    const als = new AsyncLocalStorage<Store>();
    als.run({ id: "a" }, () => {
      expect(als.getStore()).toEqual({ id: "a" });
    });
    expect(als.getStore()).toBeUndefined();
  });

  it("preserves the store across awaited microtasks", async () => {
    const als = new AsyncLocalStorage<Store>();

    await als.run({ id: "a" }, async () => {
      await Promise.resolve();
      expect(als.getStore()?.id).toBe("a");

      await delay(1);
      expect(als.getStore()?.id).toBe("a");
    });

    expect(als.getStore()).toBeUndefined();
  });
});

describe("AsyncLocalStorage — nested run()", () => {
  it("restores the outer store after a 2-level nested run()", () => {
    const als = new AsyncLocalStorage<Store>();
    const trail: string[] = [];

    als.run({ id: "L1" }, () => {
      trail.push(als.getStore()!.id);

      als.run({ id: "L2" }, () => {
        trail.push(als.getStore()!.id);
      });

      trail.push(als.getStore()!.id);
    });

    expect(trail).toEqual(["L1", "L2", "L1"]);
    expect(als.getStore()).toBeUndefined();
  });

  it("restores stores correctly through a 3-level nesting", async () => {
    const als = new AsyncLocalStorage<Store>();
    const trail: string[] = [];

    await als.run({ id: "L1" }, async () => {
      trail.push(`enter:${als.getStore()!.id}`);

      await als.run({ id: "L2" }, async () => {
        trail.push(`enter:${als.getStore()!.id}`);

        await als.run({ id: "L3" }, async () => {
          trail.push(`enter:${als.getStore()!.id}`);
        });

        trail.push(`exit:${als.getStore()!.id}`);
      });

      trail.push(`exit:${als.getStore()!.id}`);
    });

    expect(trail).toEqual([
      "enter:L1",
      "enter:L2",
      "enter:L3",
      "exit:L2",
      "exit:L1",
    ]);
    expect(als.getStore()).toBeUndefined();
  });

  it("restores stores correctly through a 4-level nesting", async () => {
    const als = new AsyncLocalStorage<Store>();
    const trail: string[] = [];

    await als.run({ id: "L1" }, async () => {
      trail.push(als.getStore()!.id);

      await als.run({ id: "L2" }, async () => {
        trail.push(als.getStore()!.id);

        await als.run({ id: "L3" }, async () => {
          trail.push(als.getStore()!.id);

          await als.run({ id: "L4" }, async () => {
            trail.push(als.getStore()!.id);
            // 깊은 await 후에도 가장 안쪽 store 유지
            await delay(1);
            expect(als.getStore()!.id).toBe("L4");
          });

          trail.push(als.getStore()!.id);
        });

        trail.push(als.getStore()!.id);
      });

      trail.push(als.getStore()!.id);
    });

    expect(trail).toEqual(["L1", "L2", "L3", "L4", "L3", "L2", "L1"]);
    expect(als.getStore()).toBeUndefined();
  });

  it("treats each nested run() as a distinct frame even when stores are equal", async () => {
    const als = new AsyncLocalStorage<{ depth: number }>();
    const seen: number[] = [];

    await als.run({ depth: 1 }, async () => {
      const outer = als.getStore();
      seen.push(als.getStore()!.depth);

      await als.run({ depth: 1 }, async () => {
        // 동일한 depth 값이지만 store 인스턴스는 별개여야 한다.
        const inner = als.getStore();
        expect(inner).not.toBe(outer);
        seen.push(inner!.depth);
      });

      // inner 종료 후 outer 인스턴스로 정확히 복원
      expect(als.getStore()).toBe(outer);
      seen.push(als.getStore()!.depth);
    });

    expect(seen).toEqual([1, 1, 1]);
  });

  it("supports interleaved nesting between two independent ALS instances", async () => {
    const tenant = new AsyncLocalStorage<{ id: string }>();
    const request = new AsyncLocalStorage<{ traceId: string }>();
    const samples: Array<[string, string]> = [];

    await tenant.run({ id: "t1" }, async () => {
      await request.run({ traceId: "r1" }, async () => {
        samples.push([tenant.getStore()!.id, request.getStore()!.traceId]);

        await tenant.run({ id: "t2" }, async () => {
          // tenant 만 t2, request 는 여전히 r1
          samples.push([tenant.getStore()!.id, request.getStore()!.traceId]);

          await request.run({ traceId: "r2" }, async () => {
            samples.push([tenant.getStore()!.id, request.getStore()!.traceId]);
          });

          // request 가 r1 으로 복원
          samples.push([tenant.getStore()!.id, request.getStore()!.traceId]);
        });

        // tenant 가 t1 으로 복원
        samples.push([tenant.getStore()!.id, request.getStore()!.traceId]);
      });
    });

    expect(samples).toEqual([
      ["t1", "r1"],
      ["t2", "r1"],
      ["t2", "r2"],
      ["t2", "r1"],
      ["t1", "r1"],
    ]);
  });
});

describe("AsyncLocalStorage — concurrency isolation", () => {
  it("isolates two concurrent top-level run() calls", async () => {
    const als = new AsyncLocalStorage<Store>();

    const probe = async (id: string, ms: number): Promise<string> => {
      return als.run({ id }, async () => {
        await delay(ms);
        return als.getStore()!.id;
      });
    };

    const [a, b, c] = await Promise.all([
      probe("a", 8),
      probe("b", 2),
      probe("c", 5),
    ]);

    expect(a).toBe("a");
    expect(b).toBe("b");
    expect(c).toBe("c");
    expect(als.getStore()).toBeUndefined();
  });

  it("keeps each 4-level chain isolated when many run concurrently", async () => {
    const als = new AsyncLocalStorage<Store>();

    const fourLevelChain = async (
      prefix: string,
      ms: number,
    ): Promise<string[]> => {
      const trail: string[] = [];
      await als.run({ id: `${prefix}1` }, async () => {
        await delay(ms);
        trail.push(als.getStore()!.id);

        await als.run({ id: `${prefix}2` }, async () => {
          await delay(ms);
          trail.push(als.getStore()!.id);

          await als.run({ id: `${prefix}3` }, async () => {
            await delay(ms);
            trail.push(als.getStore()!.id);

            await als.run({ id: `${prefix}4` }, async () => {
              await delay(ms);
              trail.push(als.getStore()!.id);
            });

            trail.push(als.getStore()!.id);
          });

          trail.push(als.getStore()!.id);
        });

        trail.push(als.getStore()!.id);
      });
      return trail;
    };

    const results = await Promise.all([
      fourLevelChain("a", 1),
      fourLevelChain("b", 4),
      fourLevelChain("c", 2),
      fourLevelChain("d", 3),
    ]);

    expect(results[0]).toEqual(["a1", "a2", "a3", "a4", "a3", "a2", "a1"]);
    expect(results[1]).toEqual(["b1", "b2", "b3", "b4", "b3", "b2", "b1"]);
    expect(results[2]).toEqual(["c1", "c2", "c3", "c4", "c3", "c2", "c1"]);
    expect(results[3]).toEqual(["d1", "d2", "d3", "d4", "d3", "d2", "d1"]);
  });

  it("does not leak the inner store back to a sibling continuation", async () => {
    const als = new AsyncLocalStorage<Store>();

    await als.run({ id: "outer" }, async () => {
      // sibling A: 내부 run() 진입 후 await
      const a = (async () => {
        return als.run({ id: "A" }, async () => {
          await delay(5);
          return als.getStore()!.id;
        });
      })();

      // sibling B: outer 컨텍스트에서 await — A 의 store 가 새지 않아야 함
      const b = (async () => {
        await delay(2);
        return als.getStore()!.id;
      })();

      const [resA, resB] = await Promise.all([a, b]);
      expect(resA).toBe("A");
      expect(resB).toBe("outer");
      expect(als.getStore()!.id).toBe("outer");
    });
  });
});

describe("AsyncLocalStorage — exception handling", () => {
  it("restores the parent store after a nested run() throws", async () => {
    const als = new AsyncLocalStorage<Store>();

    await als.run({ id: "outer" }, async () => {
      expect(als.getStore()!.id).toBe("outer");

      await expect(
        als.run({ id: "inner" }, async () => {
          expect(als.getStore()!.id).toBe("inner");
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(als.getStore()!.id).toBe("outer");
    });

    expect(als.getStore()).toBeUndefined();
  });

  it("restores all outer frames when the deepest of 4 levels throws", async () => {
    const als = new AsyncLocalStorage<Store>();
    const seen: string[] = [];

    await als.run({ id: "L1" }, async () => {
      seen.push(als.getStore()!.id);

      try {
        await als.run({ id: "L2" }, async () => {
          seen.push(als.getStore()!.id);

          await als.run({ id: "L3" }, async () => {
            seen.push(als.getStore()!.id);

            await als.run({ id: "L4" }, async () => {
              seen.push(als.getStore()!.id);
              throw new Error("deep failure");
            });
          });
        });
      } catch (err) {
        seen.push(`caught:${(err as Error).message}`);
      }

      // throw 가 L4 에서 발생했어도 L1 은 복원되어야 한다
      seen.push(`final:${als.getStore()!.id}`);
    });

    expect(seen).toEqual([
      "L1",
      "L2",
      "L3",
      "L4",
      "caught:deep failure",
      "final:L1",
    ]);
    expect(als.getStore()).toBeUndefined();
  });
});

describe("AsyncLocalStorage — regions & cross-region resource sharing", () => {
  // 각 ALS 인스턴스를 독립된 "리전"으로 본다.
  // 리전끼리 자원을 공유했을 때 일어나는 일을 관찰한다.

  it("two regions hold independent stores in the same async frame", () => {
    const tenant = new AsyncLocalStorage<{ id: string }>();
    const trace = new AsyncLocalStorage<{ trace: string }>();

    tenant.run({ id: "T" }, () => {
      trace.run({ trace: "X" }, () => {
        expect(tenant.getStore()).toEqual({ id: "T" });
        expect(trace.getStore()).toEqual({ trace: "X" });
      });
      // trace 리전이 끝나도 tenant 리전은 영향 없음
      expect(tenant.getStore()).toEqual({ id: "T" });
      expect(trace.getStore()).toBeUndefined();
    });
  });

  it("getStore() of region B is undefined inside region A's run()", () => {
    // 리전 격리: A 안에서 B 를 조회해도 A 의 frame 으로는 B 가 보이지 않는다.
    const a = new AsyncLocalStorage<{ a: number }>();
    const b = new AsyncLocalStorage<{ b: number }>();

    a.run({ a: 1 }, () => {
      expect(a.getStore()).toEqual({ a: 1 });
      expect(b.getStore()).toBeUndefined();
    });
  });

  it("ALS does not copy the store — mutations inside run() persist on the original object", () => {
    // ALS 는 store 를 그대로 참조한다. 런타임 격리는 frame 차원이지 값 차원이 아니다.
    const als = new AsyncLocalStorage<{ x: number }>();
    const obj = { x: 0 };

    als.run(obj, () => {
      als.getStore()!.x = 42;
    });

    expect(obj.x).toBe(42);
  });

  it("a single mutable object shared across two regions is observable from both", () => {
    // 같은 객체 참조를 두 리전의 store 로 넣으면 한 쪽 변경이 다른 쪽에 그대로 반영된다.
    const shared = { hits: 0 };
    const regionA = new AsyncLocalStorage<typeof shared>();
    const regionB = new AsyncLocalStorage<typeof shared>();

    regionA.run(shared, () => {
      regionB.run(shared, () => {
        regionA.getStore()!.hits++;
        expect(regionB.getStore()!.hits).toBe(1);
        regionB.getStore()!.hits++;
        expect(regionA.getStore()!.hits).toBe(2);
      });
    });

    // run() 종료 후에도 외부 객체에 그대로 남는다
    expect(shared.hits).toBe(2);
  });

  it("a closure captured inside a region can leak the store past run()", () => {
    // run() 이 종료돼도 closure 가 store 를 잡고 있으면 자원은 살아남는다.
    // 메모리 누수의 흔한 패턴 — 리전 경계가 GC 경계가 아님을 보여준다.
    const als = new AsyncLocalStorage<{ payload: number[] }>();
    let leak: (() => number[]) | null = null;

    als.run({ payload: [1, 2, 3] }, () => {
      const captured = als.getStore()!;
      leak = () => captured.payload;
    });

    expect(als.getStore()).toBeUndefined();
    expect(leak!()).toEqual([1, 2, 3]);
  });

  it("a Promise's .then() callback inherits the frame at registration time", async () => {
    // .then 은 await 한 쪽이 아니라 .then 을 등록한 frame 으로 실행된다.
    const als = new AsyncLocalStorage<{ id: string }>();
    const captures: Array<string | undefined> = [];

    const promise = als.run({ id: "A" }, () => {
      // 리전 A 안에서 등록된 then
      return Promise.resolve().then(() => {
        captures.push(als.getStore()?.id);
      });
    });

    // 리전 밖에서 등록된 then
    await promise.then(() => {
      captures.push(als.getStore()?.id);
    });

    expect(captures[0]).toBe("A");
    expect(captures[1]).toBeUndefined();
  });

  it("setTimeout / setImmediate scheduled inside a region keep the region's store", async () => {
    // async_hooks 통합으로 timer 콜백은 스케줄링 시점의 frame 을 그대로 들고 간다.
    const als = new AsyncLocalStorage<{ id: string }>();

    const fromTimeout = await new Promise<string | undefined>((resolve) => {
      als.run({ id: "T" }, () => {
        setTimeout(() => resolve(als.getStore()?.id), 1);
      });
    });

    const fromImmediate = await new Promise<string | undefined>((resolve) => {
      als.run({ id: "I" }, () => {
        setImmediate(() => resolve(als.getStore()?.id));
      });
    });

    expect(fromTimeout).toBe("T");
    expect(fromImmediate).toBe("I");
    expect(als.getStore()).toBeUndefined();
  });

  it("a continuation resumed from outside the region still sees the region's store", async () => {
    // 외부 코드가 resolver 를 호출해도 await 의 continuation 은 await 시점의 frame 으로 복귀한다.
    const als = new AsyncLocalStorage<{ id: string }>();

    let externalResolve!: () => void;
    const gate = new Promise<void>((resolve) => {
      externalResolve = resolve;
    });

    const work = als.run({ id: "A" }, async () => {
      await gate;
      return als.getStore()?.id;
    });

    // resolve 호출자는 리전 A 와 무관 — 그러나 continuation 은 A 로 돌아온다
    expect(als.getStore()).toBeUndefined();
    externalResolve();

    expect(await work).toBe("A");
  });

  it("a shared resource (Map) loses region isolation — writes from any region are globally visible", async () => {
    // Map 자체가 공유되면 리전 경계는 의미가 없다. ALS 는 frame 만 격리하고 값은 격리하지 않는다.
    const sharedMap = new Map<string, number>();
    const regionA = new AsyncLocalStorage<{ map: Map<string, number> }>();
    const regionB = new AsyncLocalStorage<{ map: Map<string, number> }>();

    await regionA.run({ map: sharedMap }, async () => {
      regionA.getStore()!.map.set("a", 1);

      await regionB.run({ map: sharedMap }, async () => {
        regionB.getStore()!.map.set("b", 2);
        // B 에서 A 가 쓴 값까지 모두 보인다
        expect(regionB.getStore()!.map.get("a")).toBe(1);
      });

      // A 에서도 B 가 쓴 값이 보인다
      expect(regionA.getStore()!.map.get("b")).toBe(2);
    });

    expect(sharedMap.size).toBe(2);
  });

  it("concurrent writes through two regions onto a shared counter exhibit lost-update", async () => {
    // ALS 는 동시성 제어 도구가 아님을 보여준다. read-modify-write 가 인터리브되면 카운터가 유실된다.
    const counter = { value: 0 };
    const regionA = new AsyncLocalStorage<typeof counter>();
    const regionB = new AsyncLocalStorage<typeof counter>();

    const incThroughRegion = (
      als: AsyncLocalStorage<typeof counter>,
    ): Promise<void> =>
      als.run(counter, async () => {
        const prev = als.getStore()!.value;
        await delay(3); // 스케줄러가 다른 region 으로 전환할 시간 보장
        als.getStore()!.value = prev + 1;
      });

    await Promise.all([
      incThroughRegion(regionA),
      incThroughRegion(regionB),
      incThroughRegion(regionA),
      incThroughRegion(regionB),
    ]);

    // 4 번 증가시켰지만 모두 prev=0 을 읽고 1 을 써넣는 lost update 패턴이 발생한다
    // (정확히 1 이라고 단정하지 않고 race 로 인한 손실을 검증)
    expect(counter.value).toBeLessThan(4);
    expect(counter.value).toBeGreaterThanOrEqual(1);
  });

  it("a registry indexed by region tag stays consistent across re-entry", () => {
    // 흔한 패턴: 외부 registry 에 region.id 로 자원을 묶어둔다.
    // 같은 store 객체로 재진입해도 동일 키가 나오는지 확인한다.
    const registry = new Map<string, number>();
    const als = new AsyncLocalStorage<{ tag: string }>();

    const touch = (): void => {
      const tag = als.getStore()!.tag;
      registry.set(tag, (registry.get(tag) ?? 0) + 1);
    };

    als.run({ tag: "tenant-a" }, () => {
      touch();
      als.run({ tag: "tenant-b" }, () => {
        touch();
        als.run({ tag: "tenant-a" }, () => {
          touch();
        });
      });
      touch();
    });

    expect(registry.get("tenant-a")).toBe(3);
    expect(registry.get("tenant-b")).toBe(1);
  });
});

describe("AsyncLocalStorage — exit()", () => {
  it("exit() clears the store inside its callback and restores it on return", () => {
    const als = new AsyncLocalStorage<Store>();
    const trail: Array<string | undefined> = [];

    als.run({ id: "outer" }, () => {
      trail.push(als.getStore()?.id);

      als.exit(() => {
        trail.push(als.getStore()?.id);
      });

      trail.push(als.getStore()?.id);
    });

    expect(trail).toEqual(["outer", undefined, "outer"]);
    expect(als.getStore()).toBeUndefined();
  });

  it("a run() invoked inside exit() rebinds the parent frame on completion", () => {
    // Note: run() 안에서 종료되면 exit()의 disabled 상태로 돌아가지 않고
    // exit() 진입 직전의 store("outer")로 복원된다는 점을 검증한다.
    const als = new AsyncLocalStorage<Store>();
    const trail: Array<string | undefined> = [];

    als.run({ id: "outer" }, () => {
      als.exit(() => {
        trail.push(als.getStore()?.id);

        als.run({ id: "inner" }, () => {
          trail.push(als.getStore()?.id);
        });

        // run() 종료 후 disabled 상태가 아닌 outer 가 복원된다
        trail.push(als.getStore()?.id);
      });
    });

    expect(trail).toEqual([undefined, "inner", "outer"]);
  });
});
