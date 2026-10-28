import { MessagesSquare, PanelsTopLeft } from "lucide-react";

export default function HomePage() {
  return (
    <main className="grid h-dvh grid-cols-1 md:grid-cols-[minmax(22rem,2fr)_3fr]">
      <section
        aria-label="Chat"
        className="flex min-h-0 flex-col border-b md:border-r md:border-b-0"
      >
        <header className="flex items-center gap-2 border-b px-4 py-3 text-sm font-medium">
          <MessagesSquare aria-hidden className="size-4" />
          Chat
        </header>
        <p className="m-auto p-6 text-center text-sm text-muted-foreground">
          Conversations stream here.
        </p>
      </section>
      <section aria-label="Canvas" className="flex min-h-0 flex-col bg-muted/40">
        <header className="flex items-center gap-2 border-b px-4 py-3 text-sm font-medium">
          <PanelsTopLeft aria-hidden className="size-4" />
          Canvas
        </header>
        <p className="m-auto p-6 text-center text-sm text-muted-foreground">
          Generated artifacts render here.
        </p>
      </section>
    </main>
  );
}
