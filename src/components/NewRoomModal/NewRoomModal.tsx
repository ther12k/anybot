import React, { useEffect, useId, useRef, useState } from "react";
import { Users, X } from "lucide-react";
import { BotPersona } from "../../types";
import "./NewRoomModal.css";

interface NewRoomModalProps {
  isOpen: boolean;
  onClose: () => void;
  bots: BotPersona[];
  onCreateRoom: (name: string, memberIds: string[]) => void;
}

/** The first agent picked is the primary addressee. */
export const NewRoomModal: React.FC<NewRoomModalProps> = ({
  isOpen,
  onClose,
  bots,
  onCreateRoom,
}) => {
  const [roomName, setRoomName] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [error, setError] = useState<"name" | "members" | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const firstMemberRef = useRef<HTMLInputElement>(null);
  const id = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (isOpen) {
      setRoomName("");
      setMemberIds([]);
      setError(null);
      if (dialog && !dialog.open) dialog.showModal();
      nameInputRef.current?.focus();
    } else {
      dialog?.close();
    }
  }, [isOpen]);

  const availableMemberIds = memberIds.filter((memberId) => bots.some((bot) => bot.id === memberId));
  const toggleMember = (memberId: string) => {
    setMemberIds((previous) => previous.includes(memberId)
      ? previous.filter((id) => id !== memberId)
      : [...previous, memberId]);
    setError((previous) => previous === "members" ? null : previous);
  };

  const handleCreate = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!roomName.trim()) {
      setError("name");
      nameInputRef.current?.focus();
      return;
    }
    if (availableMemberIds.length < 2) {
      setError("members");
      firstMemberRef.current?.focus();
      return;
    }
    onCreateRoom(roomName.trim(), availableMemberIds);
  };

  return (
    <dialog ref={dialogRef} aria-labelledby={`${id}-title`} className="anybot-room-dialog"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}>
      <form className="modal select-text" onSubmit={handleCreate}>
        <header className="modal-head">
          <div>
            <h2 id={`${id}-title`}>A few good minds, together.</h2>
            <p>Create a room with distinct agent perspectives. You review requests that need approval.</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close new room"><X className="icon" aria-hidden="true" /></button>
        </header>
        <div className="modal-body">
          <div className="field">
            <label htmlFor={`${id}-name`}>Room name</label>
            <input id={`${id}-name`} ref={nameInputRef} value={roomName}
              aria-invalid={error === "name" || undefined} aria-describedby={error === "name" ? `${id}-error` : undefined}
              onChange={(event) => { setRoomName(event.target.value); setError((previous) => previous === "name" ? null : previous); }}
              placeholder="e.g. Launch planning" />
          </div>
          <fieldset aria-describedby={`${id}-members-note${error === "members" ? ` ${id}-error` : ""}`}>
            <legend className="modal-label">Choose your agents</legend>
            <p id={`${id}-members-note`} className="anybot-room-note">{availableMemberIds.length} picked · first pick is the primary agent</p>
            {bots.length < 2 && <p className="anybot-room-note">At least two available agents are needed to create a room.</p>}
            {bots.map((bot, index) => (
              <label key={bot.id} className="checkbox-row">
                <input type="checkbox" ref={index === 0 ? firstMemberRef : undefined}
                  checked={availableMemberIds.includes(bot.id)} onChange={() => toggleMember(bot.id)} />
                <span className="shrink-0" aria-hidden="true">{bot.avatar}</span>
                <span className="min-w-0 break-words">{bot.name} <span className="text-tertiary">@{bot.slug}</span></span>
                {availableMemberIds[0] === bot.id && <span className="tag shrink-0">Primary</span>}
              </label>
            ))}
          </fieldset>
          {error && <p id={`${id}-error`} className="caption-note text-danger" role="alert">
            {error === "name" ? "Give the room a name." : "Pick at least 2 agents — a room is a shared conversation."}
          </p>}
          <p className="caption-note">
            In a room, <code>@mention</code> routes your message. Mentioned agents respond in turn; messages without a mention go to the primary agent.
          </p>
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={bots.length < 2}>
            <Users className="icon" aria-hidden="true" /> Create room
          </button>
        </footer>
      </form>
    </dialog>
  );
};
