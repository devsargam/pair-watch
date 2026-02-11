import fs from "fs";
import path from "path";
import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { parseIndexList } from "./utils";

type SizeEntry = { label: string; size: number };
type UploadState = {
  total: number;
  uploading: string[];
  uploaded: string[];
  failed: string[];
  skipped: number;
};

type UploadReporter = {
  start: (name: string) => void;
  success: (name: string) => void;
  fail: (name: string) => void;
  setSkipped: (count: number) => void;
  close: () => void;
};

export async function selectFiles(files: string[], baseDir: string) {
  if (!process.stdin.isTTY) return files;

  const choice = await promptInk({
    title: "Select which files to upload",
    lines: [
      "1) All files",
      "2) Choose by folder (top-level)",
      "3) Choose by file",
    ],
    placeholder: "Choice [1/2/3]",
  });

  if (choice === "2") {
    const folderLines = await buildFolderLines(files, baseDir);
    if (folderLines.entries.length === 0) return files;
    const answer = await promptInk({
      title: "Select folders to upload",
      lines: folderLines.lines,
      placeholder: "Selection (e.g. 1,3 or all)",
    });
    if (!answer || answer === "all") return files;
    const indexes = parseIndexList(answer, folderLines.entries.length);
    const selectedFolders = new Set(indexes.map((idx) => folderLines.entries[idx].label));
    return files.filter((file) =>
      selectedFolders.has(path.relative(baseDir, file).split(path.sep)[0]),
    );
  }

  if (choice === "3") {
    const fileLines = await buildFileLines(files, baseDir);
    if (fileLines.entries.length === 0) return files;
    const answer = await promptInk({
      title: "Select files to upload",
      lines: fileLines.lines,
      placeholder: "Selection (e.g. 1,3-5 or all)",
    });
    if (!answer || answer === "all") return files;
    const indexes = parseIndexList(answer, fileLines.entries.length);
    return indexes.map((idx) => files[idx]);
  }

  return files;
}

export function createUploadReporter(total: number): UploadReporter {
  if (!process.stdout.isTTY) {
    return {
      start: () => {},
      success: () => {},
      fail: () => {},
      setSkipped: () => {},
      close: () => {},
    };
  }

  const store = new UploadStore({
    total,
    uploading: [],
    uploaded: [],
    failed: [],
    skipped: 0,
  });
  const { unmount } = render(<UploadApp store={store} />, {
    patchConsole: false,
    incrementalRendering: true,
    maxFps: 30,
  });

  return {
    start: (name) =>
      store.update((state) => ({
        ...state,
        uploading: state.uploading.includes(name)
          ? state.uploading
          : [...state.uploading, name],
      })),
    success: (name) =>
      store.update((state) => ({
        ...state,
        uploading: state.uploading.filter((item) => item !== name),
        uploaded: [...state.uploaded, name],
      })),
    fail: (name) =>
      store.update((state) => ({
        ...state,
        uploading: state.uploading.filter((item) => item !== name),
        failed: [...state.failed, name],
      })),
    setSkipped: (count) =>
      store.update((state) => ({ ...state, skipped: count })),
    close: () => unmount(),
  };
}

async function buildFileLines(files: string[], baseDir: string) {
  const entries: SizeEntry[] = [];
  for (const file of files) {
    const stats = await fs.promises.stat(file);
    entries.push({ label: path.relative(baseDir, file), size: stats.size });
  }
  const lines = formatEntries(entries);
  return { entries, lines };
}

async function buildFolderLines(files: string[], baseDir: string) {
  const folderSizes = new Map<string, number>();
  for (const file of files) {
    const stats = await fs.promises.stat(file);
    const folder = path.relative(baseDir, file).split(path.sep)[0];
    folderSizes.set(folder, (folderSizes.get(folder) ?? 0) + stats.size);
  }
  const entries = Array.from(folderSizes.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, size]) => ({ label, size }));
  const lines = formatEntries(entries);
  return { entries, lines };
}

function formatEntries(entries: SizeEntry[]) {
  const maxSize = Math.max(1, ...entries.map((entry) => entry.size));
  const maxLabel = Math.min(
    48,
    Math.max(8, ...entries.map((entry) => entry.label.length)),
  );
  const barWidth = Math.max(
    18,
    Math.min(40, (process.stdout.columns ?? 80) - maxLabel - 10),
  );

  return entries.map((entry, index) => {
    const percent = Math.round((entry.size / maxSize) * 100);
    const filled = Math.max(1, Math.round((percent / 100) * barWidth));
    const bar = "-".repeat(filled).padEnd(barWidth, " ");
    const label = entry.label.padEnd(maxLabel, " ");
    const pct = `${percent}`.padStart(3, " ");
    return `${String(index + 1).padStart(2, " ")}. ${label} ${bar} ${pct}%`;
  });
}

function promptInk(options: { title: string; lines: string[]; placeholder: string }) {
  return new Promise<string>((resolve) => {
    const { unmount } = render(
      <Prompt
        title={options.title}
        lines={options.lines}
        placeholder={options.placeholder}
        onSubmit={(value) => {
          resolve(value);
          unmount();
        }}
      />,
      {
        patchConsole: false,
        incrementalRendering: true,
        maxFps: 30,
      },
    );
  });
}

function Prompt(props: {
  title: string;
  lines: string[];
  placeholder: string;
  onSubmit: (value: string) => void;
}) {
  const { exit } = useApp();
  const [value, setValue] = useState("");

  useInput((input, key) => {
    if (key.return || input === "\r" || input === "\n") {
      props.onSubmit(value.trim());
      exit();
      return;
    }
    if (key.escape) {
      props.onSubmit("");
      exit();
      return;
    }
    if (key.backspace || key.delete) {
      setValue((prev) => prev.slice(0, -1));
      return;
    }
    if (input) {
      setValue((prev) => prev + input);
    }
  });

  useEffect(() => {
    return () => {
      // noop cleanup
    };
  }, []);

  return (
    <Box flexDirection="column" padding={1}>
      <Text color="cyan">{props.title}</Text>
      <Box flexDirection="column">
        {props.lines.map((line, index) => (
          <Text key={`${line}-${index}`}>{line}</Text>
        ))}
      </Box>
      <Box>
        <Text color="green">{"> "}</Text>
        <Text>{value.length ? value : props.placeholder}</Text>
      </Box>
    </Box>
  );
}

class UploadStore {
  state: UploadState;
  listeners = new Set<(state: UploadState) => void>();

  constructor(initial: UploadState) {
    this.state = initial;
  }

  subscribe(listener: (state: UploadState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  update(updater: (state: UploadState) => UploadState) {
    this.state = updater(this.state);
    this.listeners.forEach((listener) => listener(this.state));
  }
}

function UploadApp({ store }: { store: UploadStore }) {
  const [state, setState] = useState(store.state);
  const { stdout } = useStdout();
  const width = stdout.columns ?? 80;

  useEffect(() => store.subscribe(setState), [store]);

  const { bar, percent } = useMemo(() => {
    const done = state.uploaded.length + state.failed.length;
    const total = Math.max(1, state.total);
    const pct = Math.round((done / total) * 100);
    const barWidth = Math.max(12, Math.min(40, width - 24));
    const filled = Math.round((pct / 100) * barWidth);
    const barText = "█".repeat(filled).padEnd(barWidth, "░");
    return { bar: barText, percent: pct };
  }, [state, width]);

  const uploadedList = state.uploaded.slice(-5);
  const divider = "-".repeat(Math.max(10, width - 4));

  return (
    <Box
      flexDirection="column"
      padding={1}
      borderStyle="round"
      borderColor="cyan"
      width="100%"
    >
      <Text color="cyan">Upload progress</Text>
      <Text>
        {bar} {percent}%
      </Text>
      <Text dimColor>{divider}</Text>

      <Text color="yellow">Uploading</Text>
      {state.uploading.length === 0 ? (
        <Text dimColor>idle</Text>
      ) : (
        state.uploading.map((name) => <Text key={`up-${name}`}>{name}</Text>)
      )}

      <Text dimColor>{divider}</Text>

      <Text color="green">Uploaded</Text>
      {uploadedList.length === 0 ? (
        <Text dimColor>none</Text>
      ) : (
        uploadedList.map((name) => <Text key={`done-${name}`}>{name}</Text>)
      )}

      {state.failed.length > 0 ? (
        <>
          <Text dimColor>{divider}</Text>
          <Text color="red">Failed</Text>
          {state.failed.slice(-5).map((name) => (
            <Text key={`fail-${name}`}>{name}</Text>
          ))}
        </>
      ) : null}

      {state.skipped > 0 ? (
        <>
          <Text dimColor>{divider}</Text>
          <Text color="magenta">Skipped: {state.skipped}</Text>
        </>
      ) : null}
    </Box>
  );
}
