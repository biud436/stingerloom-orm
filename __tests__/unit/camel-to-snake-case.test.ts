import { camelToSnakeCase } from "../../src/utils/camelToSnakeCase";

describe("camelToSnakeCase", () => {
  it("should convert simple camelCase to snake_case", () => {
    expect(camelToSnakeCase("userName")).toBe("user_name");
  });

  it("should convert multiple humps", () => {
    expect(camelToSnakeCase("myUserName")).toBe("my_user_name");
  });

  it("should handle single word (no uppercase)", () => {
    expect(camelToSnakeCase("user")).toBe("user");
  });

  it("should handle already snake_case string", () => {
    expect(camelToSnakeCase("user_name")).toBe("user_name");
  });

  it("should handle empty string", () => {
    expect(camelToSnakeCase("")).toBe("");
  });

  it("should convert PascalCase class names", () => {
    expect(camelToSnakeCase("UserProfile")).toBe("user_profile");
  });

  it("should handle consecutive uppercase letters", () => {
    // The regex only splits on lowercase-to-uppercase transitions
    expect(camelToSnakeCase("getHTTPResponse")).toBe("get_httpresponse");
  });

  it("should handle string ending with uppercase", () => {
    // "ID" stays together since there's no lowercase-to-uppercase transition within it
    expect(camelToSnakeCase("userID")).toBe("user_id");
  });

  it("should handle single character", () => {
    expect(camelToSnakeCase("a")).toBe("a");
  });

  it("should handle all lowercase", () => {
    expect(camelToSnakeCase("alllowercase")).toBe("alllowercase");
  });

  it("should convert entity class names correctly", () => {
    expect(camelToSnakeCase("BlogPost")).toBe("blog_post");
    expect(camelToSnakeCase("OrderItem")).toBe("order_item");
    expect(camelToSnakeCase("UserAddress")).toBe("user_address");
  });
});
