// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, refreshVisibleData, useLoad } from "../src/api.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
function RecordView({
  id,
  read,
  shown = () => undefined,
}: {
  id: string;
  read: (id: string) => Promise<string>;
  shown?: (value: string) => void;
}) {
  const [load] = useLoad(id, () => read(id));
  const value = load.state === "ready" ? load.data : load.state;
  useLayoutEffect(() => {
    shown(value);
  });
  return <output>{value}</output>;
}
async function until(value: string) {
  for (let i = 0; i < 30 && container.textContent !== value; i++) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 2));
    });
  }
  expect(container.textContent).toBe(value);
}

describe("visible record refresh", () => {
  it("refreshes after focus, visibility return and an explicit refresh", async () => {
    const read = vi.fn().mockResolvedValue("one");
    act(() => {
      root.render(<RecordView id="profile:day" read={read} />);
    });
    await until("one");
    read.mockResolvedValue("two");
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await until("two");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    read.mockResolvedValue("three");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(read).toHaveBeenCalledTimes(2);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await until("three");
    read.mockResolvedValue("four");
    act(() => {
      refreshVisibleData();
    });
    await until("four");
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("queues one refresh behind an in-flight read instead of overlapping or losing it", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    act(() => {
      root.render(<RecordView id="profile:day" read={read} />);
    });
    act(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      refreshVisibleData();
    });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.resolve("before chat");
      await first.promise;
    });
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => {
      second.resolve("after chat");
      await second.promise;
    });
    await until("after chat");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("never commits the previous key's data while changing profile/date", async () => {
    const second = deferred<string>();
    const read = vi.fn().mockResolvedValueOnce("Alice").mockReturnValueOnce(second.promise);
    act(() => {
      root.render(<RecordView id="alice:today" read={read} />);
    });
    await until("Alice");
    const shown: string[] = [];
    act(() => {
      root.render(
        <RecordView
          id="bob:yesterday"
          read={read}
          shown={(value) => {
            shown.push(value);
          }}
        />,
      );
    });
    expect(shown).not.toContain("Alice");
    expect(container.textContent).toBe("loading");
    await act(async () => {
      second.resolve("Bob");
      await second.promise;
    });
    await until("Bob");
  });

  it("ignores superseded responses and removes access when a session expires", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    act(() => {
      root.render(<RecordView id="alice:today" read={read} />);
    });
    act(() => {
      root.render(<RecordView id="bob:today" read={read} />);
    });
    await act(async () => {
      second.resolve("Bob");
      await second.promise;
    });
    await until("Bob");
    await act(async () => {
      first.resolve("Alice");
      await first.promise;
    });
    expect(container.textContent).toBe("Bob");
    read.mockRejectedValue(new ApiError(401, "invalid_credential", "Expired"));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await until("expired");
    expect(container.textContent).not.toContain("Bob");
  });
});
