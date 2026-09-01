"use client";

import { Component, Fragment, type ReactNode } from "react";
import { Empty } from "../ui/empty";

type EditorBoundaryProps = {
  value: string;
  children: ReactNode;
};

type EditorBoundaryState = {
  hasError: boolean;
  showRaw: boolean;
  resetKey: number;
};

export class EditorBoundary extends Component<EditorBoundaryProps, EditorBoundaryState> {
  state: EditorBoundaryState = {
    hasError: false,
    showRaw: false,
    resetKey: 0,
  };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidUpdate(prevProps: EditorBoundaryProps) {
    if (this.state.hasError && prevProps.value !== this.props.value) {
      this.setState((state) => ({
        hasError: false,
        showRaw: false,
        resetKey: state.resetKey + 1,
      }));
    }
  }

  private reload = () => {
    this.setState((state) => ({
      hasError: false,
      showRaw: false,
      resetKey: state.resetKey + 1,
    }));
  };

  private toggleRaw = () => {
    this.setState((state) => ({ showRaw: !state.showRaw }));
  };

  render() {
    if (!this.state.hasError) {
      return <Fragment key={this.state.resetKey}>{this.props.children}</Fragment>;
    }

    return (
      <div className="mx-auto my-8 flex max-w-[640px] flex-col items-center gap-4 px-5 py-8">
        <Empty
          icon="document-text-linear"
          title="This page couldn't render in the editor"
          hint="You can still view and copy the raw markdown."
        />
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={this.toggleRaw}
            aria-expanded={this.state.showRaw}
            className="rounded-md px-3 py-1.5 text-[13px] text-ink-2 transition-colors hover:bg-fill-hover hover:text-ink"
          >
            {this.state.showRaw ? "Hide raw markdown" : "View raw markdown"}
          </button>
          <button
            type="button"
            onClick={this.reload}
            className="rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-paper transition-opacity hover:opacity-90"
          >
            Reload
          </button>
        </div>
        {this.state.showRaw && (
          <pre
            tabIndex={0}
            aria-label="Raw markdown"
            className="max-h-[50vh] w-full overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-surface p-3 text-left font-mono text-[12px] leading-relaxed text-ink-2 selection:bg-selection"
          >
            {this.props.value}
          </pre>
        )}
      </div>
    );
  }
}
