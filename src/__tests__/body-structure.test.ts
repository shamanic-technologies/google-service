import { describe, it, expect } from "vitest";
import { structureBody, joinLines, LONG_URL_CHARS } from "../services/body-structure";

const clean = (text: string) => joinLines(structureBody(text));

describe("structureBody", () => {
  it("cuts quoted history at a reply header wrapped over two lines, and drops > lines", () => {
    const text = [
      "Kevin,",
      "",
      "Following up on my previous email.",
      "",
      "On Mon, October 5, 2026 3:18 PM, Summer Williams <summer@x.com>",
      "[summer@x.com]> wrote:",
      "",
      "> Hey Kevin,",
      "> We wanted to get in touch.",
    ].join("\n");
    expect(clean(text)).toBe("Kevin,\n\nFollowing up on my previous email.");
  });

  it("cuts at French, Outlook and forwarded-message separators", () => {
    expect(clean("Oui merci\n\nLe lun. 5 oct. 2026 à 10:00, Jean <j@x.fr> a écrit :\n> Bonjour")).toBe("Oui merci");
    expect(clean("Sounds good\n\nFrom: Jane <j@x.com>\nSent: Monday\nTo: Kevin\nSubject: Hi\n\nOld text")).toBe(
      "Sounds good"
    );
    expect(clean("FYI\n---------- Forwarded message ---------\nFrom: a@b.c\nhello")).toBe("FYI");
    expect(clean("Thanks\n-----Original Message-----\nold")).toBe("Thanks");
  });

  it("cuts at the signature delimiter, with or without its trailing space", () => {
    expect(clean("Do you have time Thursday?\n -- \n Tru Patrick\nDistribute.you")).toBe("Do you have time Thursday?");
    expect(clean("Do you have time Thursday?\n--\nTru")).toBe("Do you have time Thursday?");
  });

  it("removes long tracking URLs and keeps short readable ones", () => {
    const tracking = `https://www.linkedin.com/comm/messaging/thread/2?${"x".repeat(LONG_URL_CHARS)}`;
    expect(clean(`View message: ${tracking}`)).toBe("View message:");
    expect(clean("Pick a time here: https://web.docdinners.com/appointment-booking-page .")).toBe(
      "Pick a time here: https://web.docdinners.com/appointment-booking-page ."
    );
    expect(clean(`Marwene Amor\n(${tracking})`)).toBe("Marwene Amor");
  });

  it("drops wordless lines (stray braces, dotted and dashed rules) and keeps a paragraph break there", () => {
    expect(clean("You have 1 new message\n.....................\nMarwene Amor\n}\n----------\nFooter")).toBe(
      "You have 1 new message\n\nMarwene Amor\n\nFooter"
    );
  });

  it("does not cut on a sentence that merely starts with On", () => {
    expect(clean("On Monday I can do 10am.\nDoes that work?")).toBe("On Monday I can do 10am.\nDoes that work?");
  });

  it("returns nothing when the message is only quoted history", () => {
    expect(structureBody("On Mon, Jane <j@x.com> wrote:\n> hi")).toEqual([]);
  });
});
