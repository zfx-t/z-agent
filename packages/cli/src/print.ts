import type { Agent } from "@z-agent/agent";
import { StreamRenderer } from "./render.ts";

export async function runPrint(agent: Agent, prompt: string, verbose: boolean): Promise<void> {
	const renderer = new StreamRenderer({ verbose });
	const unsubscribe = agent.subscribe((event) => {
		renderer.handle(event);
	});
	try {
		await agent.prompt(prompt);
	} finally {
		unsubscribe();
	}
}
