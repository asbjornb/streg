import { describe, it, expect } from "vitest";
import { cleanCaption } from "./index.js";

describe("cleanCaption", () => {
  // Prefix patterns: "a [modifiers] [medium] of [subject]"
  it("strips 'a black and white drawing of'", () => {
    expect(cleanCaption("a black and white drawing of a cat")).toBe("a cat");
  });

  it("strips 'a simple sketch of'", () => {
    expect(cleanCaption("a simple sketch of a house")).toBe("a house");
  });

  it("strips 'a hand-drawn doodle of'", () => {
    expect(cleanCaption("a hand-drawn doodle of a flower")).toBe("a flower");
  });

  it("strips 'an ink drawing of'", () => {
    expect(cleanCaption("an ink drawing of a tree")).toBe("a tree");
  });

  it("strips 'a pencil sketch of'", () => {
    expect(cleanCaption("a pencil sketch of two birds")).toBe("two birds");
  });

  it("strips 'a monochrome illustration of'", () => {
    expect(cleanCaption("a monochrome illustration of a dog")).toBe("a dog");
  });

  // Without leading article
  it("strips 'black and white drawing of' without article", () => {
    expect(cleanCaption("black and white drawing of a cat")).toBe("a cat");
  });

  it("strips 'simple line drawing of' without article", () => {
    expect(cleanCaption("simple line drawing of a robot")).toBe("a robot");
  });

  // With preamble: "this is / there is / it is"
  it("strips 'this is a drawing of'", () => {
    expect(cleanCaption("this is a black and white drawing of a car")).toBe("a car");
  });

  it("strips 'there is a sketch of'", () => {
    expect(cleanCaption("there is a simple sketch of a sun")).toBe("a sun");
  });

  it("strips 'it looks like a drawing of'", () => {
    expect(cleanCaption("it looks like a pencil drawing of a boat")).toBe("a boat");
  });

  // Standalone color adjectives (no medium noun follows)
  it("strips 'a black and white' before a non-medium noun", () => {
    expect(cleanCaption("A black and white house amidst a vibrant, sunny day with bright blue sky and fluffy white clouds.")).toBe(
      "A house amidst a vibrant, sunny day with bright blue sky and fluffy white clouds"
    );
  });

  it("strips 'a monochrome' before a non-medium noun", () => {
    expect(cleanCaption("a monochrome cat sitting on a fence")).toBe("a cat sitting on a fence");
  });

  it("strips 'a grayscale' before a non-medium noun", () => {
    expect(cleanCaption("a grayscale dog running in a field")).toBe("a dog running in a field");
  });

  it("strips bare 'black and white' before a non-medium noun", () => {
    expect(cleanCaption("black and white house on a hill")).toBe("house on a hill");
  });

  // Trailing medium phrases
  it("strips trailing ', in black and white'", () => {
    expect(cleanCaption("a cat, in black and white")).toBe("a cat");
  });

  it("strips trailing 'in monochrome'", () => {
    expect(cleanCaption("a house in monochrome")).toBe("a house");
  });

  // Drawn/sketched suffixes
  it("strips ', drawn in pencil'", () => {
    expect(cleanCaption("a cat, drawn in pencil")).toBe("a cat");
  });

  it("strips ', sketched in ink'", () => {
    expect(cleanCaption("two dogs, sketched in ink")).toBe("two dogs");
  });

  // Mid-sentence medium phrases
  it("strips mid-sentence 'black and white drawing'", () => {
    expect(cleanCaption("a cat, black and white drawing, on a mat")).toBe("a cat on a mat");
  });

  // "Caption:" / "Answer:" prefix
  it("strips 'Answer:' prefix", () => {
    expect(cleanCaption("Answer: a black and white drawing of a cat")).toBe("a cat");
  });

  it("strips 'Caption:' prefix", () => {
    expect(cleanCaption("Caption: a dog")).toBe("a dog");
  });

  // Multiple modifiers
  it("strips multiple adjectives before medium noun", () => {
    expect(cleanCaption("a simple hand-drawn crayon sketch of a rainbow")).toBe("a rainbow");
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

  // Edge cases
  it("handles empty string", () => {
    expect(cleanCaption("")).toBe("");
  });

  it("strips 'the drawing of'", () => {
    expect(cleanCaption("the drawing of a fish")).toBe("a fish");
  });

  // Grayscale variant
  it("strips 'a grayscale sketch of'", () => {
    expect(cleanCaption("a grayscale sketch of a bird")).toBe("a bird");
  });

  // VQA preambles (BLIP-2 responses to "What are the main objects?")
  it("strips 'the main objects are' preamble", () => {
    expect(cleanCaption("the main objects are a black and white boat")).toBe("a boat");
  });

  it("strips 'the main object is' preamble", () => {
    expect(cleanCaption("the main object is a black and white boat")).toBe("a boat");
  });

  it("strips 'there are' preamble", () => {
    expect(cleanCaption("there are a black and white boat")).toBe("a boat");
  });

  it("strips 'Objects:' prefix", () => {
    expect(cleanCaption("Objects: a black and white boat")).toBe("a boat");
  });

  it("strips 'Object:' prefix", () => {
    expect(cleanCaption("Object: a cat")).toBe("a cat");
  });

  // Trailing "that is/which is" + color adjective
  it("strips trailing 'that is black and white'", () => {
    expect(cleanCaption("a boat that is black and white")).toBe("a boat");
  });

  it("strips trailing 'which is monochrome'", () => {
    expect(cleanCaption("a boat which is monochrome")).toBe("a boat");
  });
});
