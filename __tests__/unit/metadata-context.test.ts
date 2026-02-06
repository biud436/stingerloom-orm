import { describe, it, expect, beforeEach } from "@jest/globals";
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
