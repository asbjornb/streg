import { describe, it, expect } from "vitest";
import { cleanCaption } from "./index.js";

describe("cleanCaption", () => {
  // Medium noun + "of" patterns
  it("strips 'a black and white drawing of'", () => {
    expect(cleanCaption("a black and white drawing of a cat")).toBe("a cat");
  });

  it("strips 'a simple sketch of'", () => {
    expect(cleanCaption("a simple sketch of a house")).toBe("a house");
  });

  it("strips 'an ink drawing of'", () => {
    expect(cleanCaption("an ink drawing of a tree")).toBe("a tree");
  });

  // Preamble stripping
  it("strips 'this is a drawing of'", () => {
    expect(cleanCaption("this is a black and white drawing of a car")).toBe("a car");
  });

  it("strips 'the main objects are' preamble", () => {
    expect(cleanCaption("the main objects are a black and white boat")).toBe("a boat");
  });

  it("strips 'Objects:' prefix", () => {
    expect(cleanCaption("Objects: a black and white boat")).toBe("a boat");
  });

  it("strips 'Answer:' prefix", () => {
    expect(cleanCaption("Answer: a black and white drawing of a cat")).toBe("a cat");
  });

  // Color word removal (the main fix)
  it("strips 'black and white' anywhere", () => {
    expect(cleanCaption("a black and white boat")).toBe("a boat");
  });

  it("strips 'black and white' from arbitrary position", () => {
    expect(cleanCaption("I see a black and white boat on the water")).toBe("I see a boat on the water");
  });

  it("strips 'black & white'", () => {
    expect(cleanCaption("A black & white boat")).toBe("A boat");
  });

  it("strips 'b&w'", () => {
    expect(cleanCaption("a b&w cat")).toBe("a cat");
  });

  it("strips 'monochrome'", () => {
    expect(cleanCaption("a monochrome boat on a lake")).toBe("a boat on a lake");
  });

  it("strips 'grayscale'", () => {
    expect(cleanCaption("a grayscale dog running in a field")).toBe("a dog running in a field");
  });

  it("strips standalone 'black' and 'white'", () => {
    expect(cleanCaption("a black boat")).toBe("a boat");
    expect(cleanCaption("a white cat")).toBe("a cat");
  });

  // Drawn/sketched suffixes
  it("strips ', drawn in pencil'", () => {
    expect(cleanCaption("a cat, drawn in pencil")).toBe("a cat");
  });

  // Pass-through: should NOT strip actual content
  it("preserves clean captions", () => {
    expect(cleanCaption("a cat sitting on a mat")).toBe("a cat sitting on a mat");
  });

  it("preserves 'a house with a garden'", () => {
    expect(cleanCaption("a house with a garden")).toBe("a house with a garden");
  });

  it("preserves single-word subjects", () => {
    expect(cleanCaption("cat")).toBe("cat");
  });

  it("handles empty string", () => {
    expect(cleanCaption("")).toBe("");
  });
});
