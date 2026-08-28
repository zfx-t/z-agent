import { describe, expect, it } from "vitest";
import { matchSkills, parseSkill, reduceSkillState } from "../src/index.ts";

describe("@z-agent/skills public surface", () => {
	it("exports pure functions and erasable contracts", () => {
		expect(typeof parseSkill).toBe("function");
		expect(typeof matchSkills).toBe("function");
		expect(typeof reduceSkillState).toBe("function");
	});
});
