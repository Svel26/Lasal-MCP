import { describe, it, expect } from "vitest";
import { encodeProperty } from "../src/utils/visuPropertyEncoding.js";

describe("encodeProperty", () => {
  it("encodes constString with css propertyType", () => {
    const manifest = { propertyType: "css" };
    const result = encodeProperty("/fake", "background", manifest, "constString", "#ff0000");
    expect(result.typeId).toBe(0);
    expect(result.propTypeId).toBe(2);
    expect(result.value).toBe("#ff0000");
  });

  it("encodes datapoint source type", () => {
    const manifest = { propertyType: "variable" };
    const result = encodeProperty("/fake", "value", manifest, "datapoint", "Motor1.s_Speed");
    expect(result.typeId).toBe(4);
    expect(result.propTypeId).toBe(1);
    expect(result.refId).toBeDefined();
    expect(result.value).toBe("0:Motor1.s_Speed");
  });

  it("prepends 0: to datapoint values without station prefix", () => {
    const manifest = {};
    const result = encodeProperty("/fake", "value", manifest, "datapoint", "Obj.Channel");
    expect(result.value).toBe("0:Obj.Channel");
  });

  it("leaves datapoint values that already have station prefix", () => {
    const manifest = {};
    const result = encodeProperty("/fake", "value", manifest, "datapoint", "1:Obj.Channel");
    expect(result.value).toBe("1:Obj.Channel");
  });

  it("encodes constBool with rotation propertyType", () => {
    const manifest = { propertyType: "rotation" };
    const result = encodeProperty("/fake", "angle", manifest, "constNumber", 90);
    expect(result.typeId).toBe(17);
    expect(result.propTypeId).toBe(12);
  });

  it("encodes functionBlock source type", () => {
    const manifest = {};
    const result = encodeProperty("/fake", "handler", manifest, "functionBlock", "MyFB");
    expect(result.typeId).toBe(1);
    expect(result.propTypeId).toBe(3);
  });

  it("encodes stateScheme source type", () => {
    const manifest = {};
    const result = encodeProperty("/fake", "stateScheme", manifest, "stateScheme", "MyScheme");
    expect(result.typeId).toBe(21);
    expect(result.propTypeId).toBe(1);
  });

  it("encodes compositeControl source type", () => {
    const manifest = {};
    const result = encodeProperty("/fake", "template", manifest, "compositeControl", "MyTemplate");
    expect(result.typeId).toBe(23);
    expect(result.propTypeId).toBe(5);
  });

  it("handles unknown source type with fallback", () => {
    const manifest = {};
    const result = encodeProperty("/fake", "prop", manifest, "unknownType", "val");
    expect(result.typeId).toBe(0);
    expect(result.propTypeId).toBe(2);
  });

  it("handles theme-sig css property with typeId 17", () => {
    const manifest = { propertyType: "css" };
    const result = encodeProperty("/fake", "--theme-sig-element-primary", manifest, "constString", "#000");
    expect(result.typeId).toBe(17);
  });
});
