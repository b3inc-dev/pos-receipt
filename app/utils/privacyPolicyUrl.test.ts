import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isAllowedPrivacyPolicyUrl,
  resolvePrivacyPolicyUrl,
} from "./privacyPolicyUrl";

describe("isAllowedPrivacyPolicyUrl", () => {
  it("https / http のみ許可", () => {
    assert.equal(isAllowedPrivacyPolicyUrl("https://example.com/privacy"), true);
    assert.equal(isAllowedPrivacyPolicyUrl("http://example.com/p"), true);
    assert.equal(isAllowedPrivacyPolicyUrl("javascript:alert(1)"), false);
    assert.equal(isAllowedPrivacyPolicyUrl(""), false);
    assert.equal(isAllowedPrivacyPolicyUrl("not-a-url"), false);
  });
});

describe("resolvePrivacyPolicyUrl", () => {
  it("AppSetting を env より優先する", () => {
    assert.equal(
      resolvePrivacyPolicyUrl(
        "https://shop.example/privacy",
        "https://env.example/privacy"
      ),
      "https://shop.example/privacy"
    );
  });

  it("未設定の AppSetting では env にフォールバック", () => {
    assert.equal(
      resolvePrivacyPolicyUrl("", "https://env.example/privacy"),
      "https://env.example/privacy"
    );
    assert.equal(resolvePrivacyPolicyUrl(null, "https://env.example/privacy"), "https://env.example/privacy");
  });

  it("両方無効なら null（ダミー固定なし）", () => {
    assert.equal(resolvePrivacyPolicyUrl("", ""), null);
    assert.equal(resolvePrivacyPolicyUrl("ftp://x", "javascript:x"), null);
  });
});
