import type { Agent } from "@z-agent/agent";

const EXIT_SIGINT = 130;

/**
 * SIGINT while a run is active → agent.abort(). A second SIGINT exits 130.
 * Idle SIGINT exits 0 (REPL) or is unused in print after the process ends.
 */
export class SigintAbort {
	private abortedOnce = false;
	private attached = false;
	private readonly getAgent: () => Agent | undefined;
	private readonly exitFn: (code: number) => void;

	constructor(
		getAgent: () => Agent | undefined,
		exitFn: (code: number) => void = (code) => {
			process.exit(code);
		},
	) {
		this.getAgent = getAgent;
		this.exitFn = exitFn;
	}

	attach(): void {
		if (this.attached) {
			return;
		}
		this.attached = true;
		process.on("SIGINT", this.handleSigint);
	}

	detach(): void {
		if (!this.attached) {
			return;
		}
		this.attached = false;
		process.off("SIGINT", this.handleSigint);
	}

	/** Call after a run becomes idle so the next run gets a fresh abort budget. */
	resetAfterIdle(): void {
		this.abortedOnce = false;
	}

	handleSigint = (): void => {
		const agent = this.getAgent();
		if (agent?.state.isStreaming) {
			if (this.abortedOnce) {
				this.exitFn(EXIT_SIGINT);
				return;
			}
			this.abortedOnce = true;
			agent.abort();
			return;
		}
		this.exitFn(0);
	};
}
