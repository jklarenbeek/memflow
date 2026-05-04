/**
 * CommandPalette — Cmd+K fuzzy search
 */
import { Command } from "cmdk";
import { useState, useEffect } from "react";
import { useAppStore } from "../../stores/appStore";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const { setTheme, theme } = useAppStore();

  // Cmd+K to toggle
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  if (!open) return null;

  return (
    <div className="command-palette-overlay" onClick={() => setOpen(false)}>
      <div className="command-palette" onClick={(e) => e.stopPropagation()}>
        <Command>
          <Command.Input placeholder="Search solutions, workflows, actions..." autoFocus />
          <Command.List>
            <Command.Empty>No results found.</Command.Empty>
            <Command.Group heading="Actions">
              <Command.Item onSelect={() => { setTheme(theme === "dark" ? "light" : "dark"); setOpen(false); }}>
                Toggle Theme ({theme === "dark" ? "→ Light" : "→ Dark"})
              </Command.Item>
              <Command.Item onSelect={() => setOpen(false)}>
                New Solution
              </Command.Item>
              <Command.Item onSelect={() => setOpen(false)}>
                New Conversation
              </Command.Item>
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
