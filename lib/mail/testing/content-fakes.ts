import type {
  MailContentWorkInput,
  MailContentWorkRunnerPort,
} from "../service/content-coordinator";

export type FakeMailContentWorkStep = (
  input: MailContentWorkInput,
  signal: AbortSignal,
) => Promise<void> | void;

export class FakeMailContentWorkRunner implements MailContentWorkRunnerPort {
  readonly calls: MailContentWorkInput[] = [];
  private readonly steps: readonly FakeMailContentWorkStep[];
  private nextStep = 0;

  constructor(steps: readonly FakeMailContentWorkStep[]) {
    this.steps = Object.freeze([...steps]);
  }

  async run(input: MailContentWorkInput, signal: AbortSignal): Promise<void> {
    const step = this.steps[this.nextStep];
    if (!step) throw new Error("fake content work script exhausted");
    this.nextStep += 1;
    this.calls.push(input);
    await step(input, signal);
  }
}
