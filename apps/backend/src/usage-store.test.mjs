import assert from "node:assert/strict";
import test from "node:test";
import { createUsageStore, sanitiseUsageState } from "./usage-store.mjs";

test("usage buckets include oracleMisses in sanitise and publicView", async () => {
  const sanitised = sanitiseUsageState({
    cls_one: {
      "2026-08-23": {
        connects: 1,
        acceptedGenerations: 2,
        oracleMisses: 4
      }
    }
  });
  assert.equal(sanitised.cls_one["2026-08-23"].oracleMisses, 4);
  assert.equal(sanitised.cls_one["2026-08-23"].connects, 1);

  const missing = sanitiseUsageState({
    cls_two: {
      "2026-08-23": { connects: 1 }
    }
  });
  assert.equal(missing.cls_two["2026-08-23"].oracleMisses, 0);

  const store = createUsageStore({
    now: () => Date.parse("2026-08-23T12:00:00Z")
  });
  await store.recordOracleMiss("cls_one");
  await store.recordOracleMiss("cls_one");
  const view = store.publicView("cls_one");
  assert.equal(view.oracleMisses, 2);
  assert.equal(view.connects, 0);
});
