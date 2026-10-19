import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import ToolConfirm from "../components/tool-confirm.js";
import { DEFAULT_KEYBINDINGS } from "../config/keybindings.js";

async function mount(props: Partial<Parameters<typeof ToolConfirm>[0]> = {}) {
  const chunks: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 80,
    rows: 24,
    write: (text: string) => { chunks.push(text); return true; },
  }) as unknown as NodeJS.WriteStream;
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => stdin,
    resume: () => stdin,
    pause: () => stdin,
    read: () => null,
  }) as unknown as NodeJS.ReadStream;

  const onConfirm = vi.fn();
  const instance = render(
    h(ToolConfirm, {
      toolName: "write_file",
      input: { path: "test.txt", content: "data" },
      onConfirm,
      keybindings: DEFAULT_KEYBINDINGS,
      ...props,
    }),
    { stdout, stdin, patchConsole: false, exitOnCtrlC: false },
  );

  await new Promise((resolve) => setTimeout(resolve, 30));
  await instance.waitUntilRenderFlush();

  const stripAnsi = (text: string) => text.replaceAll(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  const getFrame = () => {
    const frames = chunks.filter((chunk) => /[a-z0-9]/i.test(stripAnsi(chunk)));
    return stripAnsi(frames.at(-1) ?? "");
  };

  return { instance, stdin, onConfirm, getFrame };
}

describe("ToolConfirm UI", () => {
  it("approves on 'y'", async () => {
    const { instance, stdin, onConfirm } = await mount();
    try {
      stdin.emit("data", "y");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith("yes");
    } finally {
      instance.unmount();
    }
  });

  it("denies immediately on 'n' without entering feedback mode", async () => {
    const { instance, stdin, onConfirm } = await mount();
    try {
      stdin.emit("data", "n");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith("no");
    } finally {
      instance.unmount();
    }
  });

  it("approves always on 'a'", async () => {
    const { instance, stdin, onConfirm } = await mount();
    try {
      stdin.emit("data", "a");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith("always");
    } finally {
      instance.unmount();
    }
  });

  it("enters feedback mode on 'd', accepts text, and submits denial with feedback on Enter", async () => {
    const { instance, stdin, onConfirm, getFrame } = await mount();
    try {
      stdin.emit("data", "d");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(getFrame()).toContain("Feedback for agent");

      stdin.emit("data", "use existing utilities");
      await new Promise((resolve) => setTimeout(resolve, 30));

      stdin.emit("data", "\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith({
        choice: "no",
        feedback: "use existing utilities",
      });
    } finally {
      instance.unmount();
    }
  });

  it("treats empty or whitespace-only feedback on Enter as plain 'no'", async () => {
    const { instance, stdin, onConfirm } = await mount();
    try {
      stdin.emit("data", "d");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "   ");
      await new Promise((resolve) => setTimeout(resolve, 30));
      stdin.emit("data", "\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith("no");
    } finally {
      instance.unmount();
    }
  });

  it("cancels feedback mode on Escape without resolving, returning to main prompt", async () => {
    const { instance, stdin, onConfirm, getFrame } = await mount();
    try {
      stdin.emit("data", "d");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(getFrame()).toContain("Feedback for agent");

      stdin.emit("data", "aborted feedback");
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Press Escape to cancel feedback mode
      stdin.emit("data", "\x1b");
      await new Promise((resolve) => setTimeout(resolve, 100));
      await instance.waitUntilRenderFlush();
      expect(onConfirm).not.toHaveBeenCalled();
      expect(getFrame()).not.toContain("Feedback for agent");

      // Now pressing 'y' should approve
      stdin.emit("data", "y");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(onConfirm).toHaveBeenCalledWith("yes");
    } finally {
      instance.unmount();
    }
  });

  it("handles backspace key while typing feedback", async () => {
    const { instance, stdin, onConfirm } = await mount();
    try {
      stdin.emit("data", "d");
      await new Promise((resolve) => setTimeout(resolve, 30));

      stdin.emit("data", "abc");
      await new Promise((resolve) => setTimeout(resolve, 30));

      stdin.emit("data", "\x7f"); // Backspace
      await new Promise((resolve) => setTimeout(resolve, 30));

      stdin.emit("data", "\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith({
        choice: "no",
        feedback: "ab",
      });
    } finally {
      instance.unmount();
    }
  });

  it("does not show [D]eny with feedback or enter feedback mode for background-job prompts", async () => {
    // Construct a minimal input that satisfies parseBackgroundConfirmInput():
    // action must be a string, spec must have cwd (string), isolation (truthy),
    // and invocation (shell mode requires commandText string).
    const backgroundInput = {
      action: "start",
      spec: {
        invocation: { mode: "shell", commandText: "echo hi", interpreter: "cmd" },
        cwd: process.cwd(),
        isolation: { backend: "none", required: false },
        env: {},
        credentialRefs: [],
        ownershipScope: "unverified",
        limits: {},
        headless: false,
      },
    };
    const { instance, stdin, onConfirm, getFrame } = await mount({
      toolName: "run_background_job",
      input: backgroundInput,
    });
    try {
      const frame = getFrame();
      // The [D]eny with feedback option must not appear on background prompts
      expect(frame).not.toContain("[D]");
      expect(frame).not.toContain("Deny with feedback");

      // Pressing 'd' must not enter feedback mode
      stdin.emit("data", "d");
      await new Promise((resolve) => setTimeout(resolve, 50));
      await instance.waitUntilRenderFlush();
      expect(getFrame()).not.toContain("Feedback for agent");
      expect(onConfirm).not.toHaveBeenCalled();

      // 'n' must still resolve with "no"
      stdin.emit("data", "n");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onConfirm).toHaveBeenCalledWith("no");
    } finally {
      instance.unmount();
    }
  });
});
