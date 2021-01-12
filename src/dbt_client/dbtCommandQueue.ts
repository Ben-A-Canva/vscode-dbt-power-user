import { singleton } from "tsyringe";
import { CancellationToken, ProgressLocation, window } from "vscode";

interface Command {
  command: (token: CancellationToken) => Promise<void>;
  statusMessage: string;
  focus?: boolean;
}
@singleton()
export class DBTCommandQueue {
  private queue: Command[] = [];
  private running = false;

  addToQueue(command: Command) {
    this.queue.push(command);
    this.pickCommandToRun();
  }

  private async pickCommandToRun(): Promise<void> {
    if (!this.running && this.queue.length > 0) {
      this.running = true;
      const { command, statusMessage, focus } = this.queue.shift()!;

      await window.withProgress(
        {
          location: focus
            ? ProgressLocation.Notification
            : ProgressLocation.Window,
          cancellable: true,
          title: statusMessage,
        },
        async (_, token) => {
          await command(token);
        }
      );

      this.running = false;
      this.pickCommandToRun();
    }
  }
}
