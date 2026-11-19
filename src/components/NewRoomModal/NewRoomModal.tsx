import React, { useEffect, useRef, useState } from "react";
import { X, Users, Check } from "lucide-react";
import { BotPersona } from "../../types";

interface NewRoomModalProps {
  isOpen: boolean;
  onClose: () => void;
  bots: BotPersona[];
  onCreateRoom: (name: string, memberIds: string[]) => void;
}

/**
 * Create a Team Room: a shared thread where multiple personas + the user
 * converse, with @mention routing. Requires a name and at least 2 members —
 * the first member picked becomes the room's primary addressee.
 */
export const NewRoomModal: React.FC<NewRoomModalProps> = ({
  isOpen,
  onClose,
  bots,
  onCreateRoom,
}) => {
  const [roomName, setRoomName] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setRoomName("");
      setMemberIds([]);
      setError(null);
      const d = dialogRef.current;
      if (d && !d.open) d.showModal();
      nameInputRef.current?.focus();
    } else {
      dialogRef.current?.close();
    }
  }, [isOpen]);

  // The IAB webview doesn't fire native `cancel` for synthesized Escape —
  // mirror the keydown fallback used by the Settings modal.
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    d.addEventListener("keydown", onKeydown);
    return () => d.removeEventListener("keydown", onKeydown);
  }, [onClose]);

  const toggleMember = (id: string) => {
    setMemberIds((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]
    );
    setError(null);
  };

  const handleCreate = () => {
    if (!roomName.trim()) {
      setError("Give the room a name.");
      return;
    }
    if (memberIds.length < 2) {
      setError("Pick at least 2 agents — a room is a shared conversation.");
      return;
    }
    onCreateRoom(roomName, memberIds);
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="new-room-title"
      className="w-[calc(100%-2rem)] max-w-md bg-chrome border border-stroke rounded-2xl shadow-xl overflow-hidden"
    >
      <div className="flex flex-col select-text">
        {/* Header */}
        <div className="px-5 h-12 border-b border-stroke flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-accent" aria-hidden="true" />
            <h3 id="new-room-title" className="text-sm font-semibold text-primary">
              New team room
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-tertiary hover:text-primary rounded-lg hover:bg-hover transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            aria-label="Close new room"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 text-xs">
          <div className="space-y-1.5">
            <label htmlFor="room-name" className="font-semibold text-secondary">
              Room name
            </label>
            <input
              id="room-name"
              ref={nameInputRef}
              value={roomName}
              onChange={(e) => {
                setRoomName(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              placeholder="e.g. dev-team"
              className="w-full h-9 px-3 rounded-xl bg-sidebar border border-stroke text-primary text-xs placeholder:text-quaternary focus:outline-none focus:border-strokeStrong focus-visible:ring-2 focus-visible:ring-accent"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-secondary">Members</span>
              <span className="text-xxs text-quaternary">
                {memberIds.length} picked · first pick is the primary agent
              </span>
            </div>
            <div className="max-h-56 overflow-y-auto rounded-xl border border-stroke divide-y divide-stroke">
              {bots.map((bot) => {
                const checked = memberIds.includes(bot.id);
                const order = memberIds.indexOf(bot.id);
                return (
                  <button
                    key={bot.id}
                    onClick={() => toggleMember(bot.id)}
                    className={`w-full px-3 py-2 flex items-center gap-2.5 text-left transition-colors ${
                      checked ? "bg-accent-soft" : "hover:bg-hover"
                    }`}
                    aria-pressed={checked}
                  >
                    <span
                      className="w-6 h-6 rounded-lg bg-hover flex items-center justify-center shrink-0 select-none"
                      aria-hidden="true"
                    >
                      {bot.avatar}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-primary truncate">
                        {bot.name}
                      </span>
                      <span className="block text-xxs text-quaternary truncate">
                        @{bot.slug}
                      </span>
                    </span>
                    {checked && order === 0 && (
                      <span className="text-xxs px-1.5 py-px rounded bg-accent/10 text-accent font-medium shrink-0">
                        primary
                      </span>
                    )}
                    <span
                      className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                        checked
                          ? "bg-accent border-accent text-white"
                          : "border-strokeStrong"
                      }`}
                      aria-hidden="true"
                    >
                      {checked && <Check className="w-3 h-3" />}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {error && (
            <p className="text-xxs text-danger" role="alert">
              {error}
            </p>
          )}

          <p className="text-xxs text-quaternary leading-relaxed">
            In a room, <span className="font-mono font-semibold text-secondary">@mention</span>{" "}
            routes your message — every mentioned agent answers in turn and sees its
            teammates' replies. Messages without a mention go to the primary agent.
          </p>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-stroke flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg border border-stroke bg-elevated hover:bg-elevatedHover text-xs font-medium text-secondary hover:text-primary transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            className="px-3 py-1.5 rounded-lg bg-accent hover:bg-accentHover text-white text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Create room
          </button>
        </div>
      </div>
    </dialog>
  );
};
