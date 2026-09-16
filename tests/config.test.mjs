import assert from "node:assert/strict";
import test from "node:test";
import { selectedProfileName } from "../src/config.mjs";

test("Profile precedence is flag, environment, saved default, then nas", () => {
  assert.equal(selectedProfileName({ profile: "one" }, { currentProfile: "two" }, { PROCLI_PROFILE: "three" }), "one");
  assert.equal(selectedProfileName({}, { currentProfile: "two" }, { PROCLI_PROFILE: "three" }), "three");
  assert.equal(selectedProfileName({}, { currentProfile: "two" }, {}), "two");
  assert.equal(selectedProfileName({}, {}, {}), "nas");
});
