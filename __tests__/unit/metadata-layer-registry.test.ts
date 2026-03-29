/**
 * MetadataLayerRegistry + MetadataScanner 고급 엣지 케이스 테스트
 *
 * metadata-context.test.ts에서 다루지 않는 영역:
 * - resolveAll() 병합 뷰
 * - addLayer() / copyLayer() / removeLayer()
 * - 다중 테넌트 간 격리
 * - MetadataScanner(EntityScanner/ColumnScanner) 병합 뷰 및 prefix 격리
 * - switchContext() 동작
 */

import "reflect-metadata";
import { getScannerInstance, resetScannerContainer } from "../../src/scanner/ScannerContainer";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";
import { EntityScanner, ColumnScanner } from "../../src/scanner";

// ────────────────────────────────────────────────────────
// 헬퍼
// ────────────────────────────────────────────────────────

function resetAll() {
  MetadataContext.reset();
  MetadataLayerRegistry.reset();
  resetScannerContainer();
}

// ────────────────────────────────────────────────────────
// MetadataLayerRegistry — OverlayFS 병합 뷰
// ────────────────────────────────────────────────────────

describe("MetadataLayerRegistry — resolveAll() 병합 뷰", () => {
  let registry: MetadataLayerRegistry;

  beforeEach(() => {
    resetAll();
    registry = MetadataLayerRegistry.getInstance();
  });

  it("public과 tenant 레이어 항목을 모두 포함한다", () => {
    registry.getCurrentLayer().set("pub_key", "pub_val");

    registry.setContext("tenant_a");
    registry.getCurrentLayer().set("tenant_key", "tenant_val");

    const all = registry.resolveAll<string>();
    expect(all.get("pub_key")).toBe("pub_val");
    expect(all.get("tenant_key")).toBe("tenant_val");
  });

  it("tenant 레이어가 public의 동일 키를 덮어쓴다", () => {
    registry.getCurrentLayer().set("shared", "from_public");

    registry.setContext("tenant_a");
    registry.getCurrentLayer().set("shared", "from_tenant");

    const all = registry.resolveAll<string>();
    expect(all.get("shared")).toBe("from_tenant");
  });

  it("public 컨텍스트에서 resolveAll은 public 레이어만 반환한다", () => {
    registry.getCurrentLayer().set("only_pub", "pub_value");

    // tenant_b에 별도 키 저장
    registry.setContext("tenant_b");
    registry.getCurrentLayer().set("tenant_b_key", "b_val");
    registry.setContext("public");

    const all = registry.resolveAll<string>();
    expect(all.get("only_pub")).toBe("pub_value");
    // public 컨텍스트에서는 tenant_b 데이터가 보이지 않음
    expect(all.has("tenant_b_key")).toBe(false);
  });

  it("tenant 컨텍스트에서는 public 항목도 병합되어 보인다", () => {
    registry.getCurrentLayer().set("pub_entity", { table: "users" });

    registry.setContext("tenant_x");
    const all = registry.resolveAll<any>();
    expect(all.get("pub_entity")).toEqual({ table: "users" });
  });
});

// ────────────────────────────────────────────────────────
// MetadataLayerRegistry — resolveValue() fallback
// ────────────────────────────────────────────────────────

describe("MetadataLayerRegistry — resolveValue() OverlayFS fallback", () => {
  let registry: MetadataLayerRegistry;

  beforeEach(() => {
    resetAll();
    registry = MetadataLayerRegistry.getInstance();
  });

  it("tenant 레이어에 없는 키는 public 레이어에서 fallback 조회된다", () => {
    registry.getCurrentLayer().set("global_key", "global_value");

    registry.setContext("tenant_x");
    const val = registry.resolveValue<string>("global_key");
    expect(val).toBe("global_value");
  });

  it("tenant 레이어 값이 public보다 우선된다 (Copy-on-Write)", () => {
    registry.getCurrentLayer().set("shared_key", "public_value");

    registry.setContext("tenant_x");
    registry.getCurrentLayer().set("shared_key", "tenant_value");

    expect(registry.resolveValue<string>("shared_key")).toBe("tenant_value");
  });

  it("public 컨텍스트에서는 tenant 데이터가 조회되지 않는다", () => {
    registry.setContext("tenant_x");
    registry.getCurrentLayer().set("tenant_only", "secret");

    registry.setContext("public");
    expect(registry.resolveValue<string>("tenant_only")).toBeUndefined();
  });

  it("어느 레이어에도 없는 키는 undefined를 반환한다", () => {
    registry.setContext("tenant_x");
    expect(registry.resolveValue("nonexistent_key")).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────
// MetadataLayerRegistry — 레이어 관리 (addLayer / copyLayer / removeLayer)
// ────────────────────────────────────────────────────────

describe("MetadataLayerRegistry — 레이어 관리", () => {
  let registry: MetadataLayerRegistry;

  beforeEach(() => {
    resetAll();
    registry = MetadataLayerRegistry.getInstance();
  });

  it("addLayer(): 이미 존재하는 이름으로 생성 시 에러가 발생한다", () => {
    expect(() => registry.addLayer("public")).toThrow(/already exists/);
  });

  it("addLayer(): 새 레이어를 생성한다", () => {
    registry.addLayer("new_tenant");
    expect(registry.getLayer("new_tenant")).toBeDefined();
  });

  it("copyLayer(): 소스 레이어의 독립적인 스냅샷을 생성한다", () => {
    registry.getCurrentLayer().set("entity_def", { columns: ["id", "name"] });

    registry.copyLayer("public", "tenant_new");

    // 복사된 레이어에서 소스 데이터 확인
    registry.setContext("tenant_new");
    const copied = registry.resolveValue<any>("entity_def");
    expect(copied).toEqual({ columns: ["id", "name"] });

    // tenant_new 수정이 public에 영향을 주지 않음
    registry.getCurrentLayer().set("entity_def", {
      columns: ["id", "name", "email"],
    });

    registry.setContext("public");
    const original = registry.resolveValue<any>("entity_def");
    expect(original).toEqual({ columns: ["id", "name"] }); // 변경 없음
  });

  it("removeLayer(): public 레이어는 삭제 불가", () => {
    expect(() => registry.removeLayer("public")).toThrow(/Cannot remove/);
  });

  it("removeLayer(): 다른 레이어는 정상 삭제된다", () => {
    registry.setContext("removable");
    expect(registry.removeLayer("removable")).toBe(true);
    expect(registry.getLayer("removable")).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────
// MetadataLayerRegistry — 다중 테넌트 격리
// ────────────────────────────────────────────────────────

describe("MetadataLayerRegistry — 다중 테넌트 간 격리", () => {
  let registry: MetadataLayerRegistry;

  beforeEach(() => {
    resetAll();
    registry = MetadataLayerRegistry.getInstance();
  });

  it("tenant_a 쓰기가 tenant_b에 영향을 주지 않는다", () => {
    registry.setContext("tenant_a");
    registry.getCurrentLayer().set("config", { plan: "premium" });

    registry.setContext("tenant_b");
    registry.getCurrentLayer().set("config", { plan: "basic" });

    registry.setContext("tenant_a");
    expect(registry.resolveValue<any>("config")).toEqual({ plan: "premium" });

    registry.setContext("tenant_b");
    expect(registry.resolveValue<any>("config")).toEqual({ plan: "basic" });
  });

  it("N개의 테넌트가 각각 독립적인 오버라이드를 가진다", () => {
    const tenants = ["t1", "t2", "t3", "t4", "t5"];

    // 각 테넌트에 고유 값 저장
    for (const t of tenants) {
      registry.setContext(t);
      registry.getCurrentLayer().set("tenant_name", t);
    }

    // 각 테넌트에서 자신의 값 조회
    for (const t of tenants) {
      registry.setContext(t);
      expect(registry.resolveValue<string>("tenant_name")).toBe(t);
    }
  });

  it("AsyncLocalStorage 동시 접근 시 테넌트별 격리가 유지된다", async () => {
    const registry2 = MetadataLayerRegistry.getInstance();

    registry2.setContext("tenant_a");
    registry2.getCurrentLayer().set("data", "tenant_a_data");

    registry2.setContext("tenant_b");
    registry2.getCurrentLayer().set("data", "tenant_b_data");

    const results = await Promise.all([
      MetadataContext.run("tenant_a", async () => {
        await new Promise((r) => setTimeout(r, 15));
        return registry2.resolveValue<string>("data");
      }),
      MetadataContext.run("tenant_b", async () => {
        await new Promise((r) => setTimeout(r, 5));
        return registry2.resolveValue<string>("data");
      }),
    ]);

    expect(results[0]).toBe("tenant_a_data");
    expect(results[1]).toBe("tenant_b_data");
  });
});

// ────────────────────────────────────────────────────────
// MetadataLayerRegistry — getLayersInfo()
// ────────────────────────────────────────────────────────

describe("MetadataLayerRegistry — getLayersInfo()", () => {
  beforeEach(() => resetAll());

  it("초기에는 public 레이어 1개만 존재한다", () => {
    const registry = MetadataLayerRegistry.getInstance();
    const info = registry.getLayersInfo();
    expect(info).toHaveLength(1);
    expect(info[0].name).toBe("public");
  });

  it("레이어 추가 후 목록에 반영된다", () => {
    const registry = MetadataLayerRegistry.getInstance();
    registry.addLayer("tenant_a");
    registry.addLayer("tenant_b");

    const names = registry.getLayersInfo().map((i) => i.name);
    expect(names).toContain("public");
    expect(names).toContain("tenant_a");
    expect(names).toContain("tenant_b");
  });
});

// ────────────────────────────────────────────────────────
// EntityScanner / ColumnScanner — 병합 뷰 및 prefix 격리
// ────────────────────────────────────────────────────────

describe("EntityScanner — allMetadata() 병합 뷰", () => {
  beforeEach(() => resetAll());

  it("public 레이어에 등록된 엔티티가 tenant 컨텍스트에서도 보인다", () => {
    // public 레이어에 엔티티 등록
    const registry = MetadataLayerRegistry.getInstance();
    registry.setContext("public");
    registry
      .getCurrentLayer()
      .set("entities::UserBase", { target: class User {}, name: "users" });

    // tenant_a 컨텍스트로 전환
    registry.setContext("tenant_a");

    const entityScanner = getScannerInstance(EntityScanner);
    const all = entityScanner.allMetadata();

    // public의 UserBase가 tenant_a에서도 보임 (fallback)
    expect(all.some((m: any) => m.name === "users")).toBe(true);
  });

  it("tenant 레이어 엔티티가 public 엔티티를 덮어쓴다", () => {
    const registry = MetadataLayerRegistry.getInstance();

    // public에 기본 엔티티
    registry.setContext("public");
    registry
      .getCurrentLayer()
      .set("entities::SharedEntity", { target: class Shared {}, name: "shared_table" });

    // tenant_a에서 덮어쓰기
    registry.setContext("tenant_a");
    registry
      .getCurrentLayer()
      .set("entities::SharedEntity", {
        target: class Shared {},
        name: "tenant_a_table",
      });

    const entityScanner = getScannerInstance(EntityScanner);
    const all = entityScanner.allMetadata<any>();

    const entry = all.find((m: any) => m.name === "tenant_a_table");
    expect(entry).toBeDefined();
    // public의 'shared_table'은 덮어써짐
    const publicEntry = all.find((m: any) => m.name === "shared_table");
    expect(publicEntry).toBeUndefined();
  });
});

describe("EntityScanner vs ColumnScanner — prefix 격리", () => {
  beforeEach(() => resetAll());

  it("EntityScanner 항목이 ColumnScanner.allMetadata()에 나타나지 않는다", () => {
    const registry = MetadataLayerRegistry.getInstance();
    registry.setContext("public");

    // EntityScanner prefix ('entities::') 로 저장
    registry
      .getCurrentLayer()
      .set("entities::User", { name: "users", target: class User {} });

    // ColumnScanner prefix ('columns::') 로 저장
    registry
      .getCurrentLayer()
      .set("columns::id", { name: "id", type: "int" });

    const entityScanner = getScannerInstance(EntityScanner);
    const columnScanner = getScannerInstance(ColumnScanner);

    const entities = entityScanner.allMetadata();
    const columns = columnScanner.allMetadata();

    // EntityScanner는 entities:: 만 봄
    expect(entities.some((m: any) => m.name === "users")).toBe(true);
    expect(entities.some((m: any) => m.name === "id")).toBe(false);

    // ColumnScanner는 columns:: 만 봄
    expect(columns.some((m: any) => m.name === "id")).toBe(true);
    expect(columns.some((m: any) => m.name === "users")).toBe(false);
  });
});

describe("MetadataScanner — has() / size / switchContext()", () => {
  beforeEach(() => resetAll());

  it("has()가 public fallback을 포함한 병합 뷰를 검사한다", () => {
    const registry = MetadataLayerRegistry.getInstance();
    registry.setContext("public");
    registry
      .getCurrentLayer()
      .set("entities::GlobalEntity", { name: "global" });

    registry.setContext("tenant_x");
    const entityScanner = getScannerInstance(EntityScanner);

    // tenant_x에 직접 없지만 public에 있으므로 has() = true
    expect(entityScanner.has("GlobalEntity")).toBe(true);
    // 존재하지 않는 키
    expect(entityScanner.has("NonExistentEntity")).toBe(false);
  });

  it("size가 병합된 뷰 기준으로 반환된다", () => {
    const registry = MetadataLayerRegistry.getInstance();

    // public에 2개
    registry.setContext("public");
    registry.getCurrentLayer().set("entities::A", { name: "table_a" });
    registry.getCurrentLayer().set("entities::B", { name: "table_b" });

    // tenant에 1개 추가 (새 키)
    registry.setContext("tenant_x");
    registry.getCurrentLayer().set("entities::C", { name: "table_c" });

    const entityScanner = getScannerInstance(EntityScanner);
    // public 2개 + tenant 1개 = 3개
    expect(entityScanner.size).toBe(3);
  });

  it("switchContext()가 레지스트리 컨텍스트를 변경한다", () => {
    const registry = MetadataLayerRegistry.getInstance();
    const entityScanner = getScannerInstance(EntityScanner);

    entityScanner.switchContext("custom_tenant");
    expect(registry.getContext()).toBe("custom_tenant");
  });
});
