import { redactText, registerSecretValues } from "@tommy/logging";
import { describe, expect, it } from "vitest";
import { cardNumberLogForms } from "./vault-items";

describe("cardNumberLogForms", () => {
  it("redacts a card number in the groups that a page shows", () => {
    registerSecretValues(cardNumberLogForms("4111111111111111"));
    for (const shown of ["4111111111111111", "4111 1111 1111 1111", "4111-1111-1111-1111"]) {
      expect(redactText(`card ${shown} end`)).not.toContain("1111");
    }
  });

  it("redacts the American Express groups", () => {
    registerSecretValues(cardNumberLogForms("378282246310005"));
    for (const shown of ["3782 822463 10005", "3782-822463-10005"]) {
      expect(redactText(`card ${shown} end`)).not.toContain("822463");
    }
  });
});
