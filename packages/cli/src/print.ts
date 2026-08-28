import type { Agent, AgentMessage } from "@z-agent/agent";
import { StreamRenderer } from "./render.ts";

export async function runPrint(agent: Agent, prompt: string | AgentMessage, verbose: boolean): Promise<void> {
	const renderer = new StreamRenderer({ verbose });
	const unsubscribe = agent.subscribe((event) => {
		renderer.handle(event);
	});
	try {
		if (typeof prompt === "string") {
			await agent.prompt(prompt);
		} else {
			await agent.prompt([prompt]);
		}
	} finally {
		unsubscribe();
	}
}
