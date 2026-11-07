import { useEffect, useMemo, useRef, useState } from "react";
import { applySummaryEvent, historyMessages, mergeChatMessages } from "./chatState";

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

function roomKey(room) {
  return room ? `${room.kind}:${room.name}` : "";
}

function safeUsers(value) {
  return Array.isArray(value) ? value.filter((name) => typeof name === "string" && name) : [];
}

function safeGroups(value) {
  return Array.isArray(value)
    ? value
      .filter((group) => group && typeof group.name === "string")
      .map((group) => ({ ...group, members: safeUsers(group.members) }))
    : [];
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function App() {
  const [connection, setConnection] = useState({ connected: false, name: "", host: "127.0.0.1", port: 5050 });
  const [form, setForm] = useState({ name: "", host: "127.0.0.1", port: 5050 });
  const [users, setUsers] = useState([]);
  const [groups, setGroups] = useState([]);
  const [activeRoom, setActiveRoom] = useState(null);
  const [messages, setMessages] = useState({});
  const [messageText, setMessageText] = useState("");
  const [newGroup, setNewGroup] = useState("");
  const [notice, setNotice] = useState("");
  const [summaries, setSummaries] = useState({});
  const messageEnd = useRef(null);
  const currentName = useRef("");

  useEffect(() => {
    request("/api/status").then((status) => {
      if (status.connected) {
        currentName.current = status.name;
        setConnection(status);
        setUsers(safeUsers(status.users));
        setGroups(safeGroups(status.groups));
        setMessages((old) => mergeChatMessages(old, historyMessages(status.history), status.name));
      } else {
        setConnection((current) => ({ ...current, connected: false }));
      }
    }).catch(() => setNotice("Start the local client bridge to use chat."));

    const events = new EventSource("/api/events");
    events.onmessage = ({ data }) => {
      try {
        const event = JSON.parse(data);
        if (event.type === "snapshot") {
          if (event.connection?.connected) {
            currentName.current = event.connection.name;
            setConnection(event.connection);
            setUsers(safeUsers(event.state?.users));
            setGroups(safeGroups(event.state?.groups));
            setMessages((old) => mergeChatMessages(old, historyMessages(event.history), event.connection.name));
          }
        } else if (event.type === "registered") {
          currentName.current = event.name;
          setConnection((current) => ({ ...current, connected: true, name: event.name }));
          setNotice(`Connected as ${event.name}`);
        } else if (event.type === "state") {
          setUsers(safeUsers(event.users));
          setGroups(safeGroups(event.groups));
        } else if (event.type === "private_message" || event.type === "group_message") {
          setMessages((old) => mergeChatMessages(old, [event], currentName.current));
        } else if (event.type === "history") {
          setMessages((old) => mergeChatMessages(old, historyMessages(event), currentName.current));
        } else if (event.type === "chat_summary") {
          setSummaries((old) => applySummaryEvent(old, event));
        } else if (event.type === "error" || event.type === "connection_error") {
          setNotice(event.message || "A connection error occurred.");
        } else if (event.type === "disconnected") {
          currentName.current = "";
          setConnection((current) => ({ ...current, connected: false }));
          setUsers([]);
          setGroups([]);
          setActiveRoom(null);
          setSummaries({});
          setMessages({});
          setNotice("Disconnected from the server.");
        }
      } catch (error) {
        console.error("Ignored invalid bridge event:", error);
        setNotice("An invalid update was ignored; the connection is still active.");
      }
    };
    events.onopen = () => setNotice((current) => current === "Reconnecting to the local bridge…" ? "" : current);
    events.onerror = () => setNotice("Reconnecting to the local bridge…");
    return () => events.close();
  }, []);

  const currentMessages = messages[roomKey(activeRoom)] || [];
  const activeGroup = activeRoom?.kind === "group" ? groups.find((group) => group.name === activeRoom.name) : null;
  const isMember = activeGroup?.members.includes(connection.name) ?? false;
  const onlineUsers = useMemo(() => new Set(users), [users]);
  const people = useMemo(() => {
    const names = new Set(users);
    for (const key of Object.keys(messages)) {
      if (key.startsWith("private:")) names.add(key.slice("private:".length));
    }
    return [...names].sort((left, right) => left.localeCompare(right));
  }, [messages, users]);
  const privatePeerOnline = activeRoom?.kind !== "private" || onlineUsers.has(activeRoom.name);
  const activeSummary = summaries[roomKey(activeRoom)];

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [currentMessages.length]);

  const initials = useMemo(() => connection.name.slice(0, 2).toUpperCase(), [connection.name]);

  async function connect(event) {
    event.preventDefault();
    try {
      const state = await request("/api/connect", { method: "POST", body: JSON.stringify(form) });
      currentName.current = state.name;
      setConnection(state);
      setNotice(`Connected as ${state.name}`);
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function action(payload) {
    try {
      await request("/api/action", { method: "POST", body: JSON.stringify(payload) });
    } catch (error) {
      setNotice(error.message);
    }
  }

  function sendMessage(event) {
    event.preventDefault();
    const text = messageText.trim();
    if (!text || !activeRoom) return;
    const payload = activeRoom.kind === "private"
      ? { type: "private_message", to: activeRoom.name, text }
      : { type: "group_message", group: activeRoom.name, text };
    action(payload);
    setMessageText("");
  }

  async function summarize() {
    const room = activeRoom;
    const key = roomKey(room);
    setSummaries((old) => ({ ...old, [key]: { pending: true } }));
    try {
      await request("/api/action", {
        method: "POST",
        body: JSON.stringify({ type: "summarize_chat", kind: room.kind, name: room.name }),
      });
    } catch (error) {
      setSummaries((old) => ({ ...old, [key]: { error: error.message } }));
    }
  }

  function dismissSummary() {
    const key = roomKey(activeRoom);
    setSummaries((old) => {
      const next = { ...old };
      delete next[key];
      return next;
    });
  }

  function createGroup(event) {
    event.preventDefault();
    const group = newGroup.trim();
    if (!group) return;
    action({ type: "create_group", group });
    setNewGroup("");
    setActiveRoom({ kind: "group", name: group });
  }

  async function disconnect() {
    try {
      await request("/api/disconnect", { method: "POST", body: "{}" });
    } catch (error) {
      setNotice(error.message);
    }
  }

  if (!connection.connected) {
    return (
      <main className="login-page">
        <section className="login-card">
          <div className="brand-mark">R</div>
          <h1>Relay</h1>
          <p className="muted">Connect this computer to the chat server.</p>
          <form onSubmit={connect} className="login-form">
            <label>Display name<input required maxLength="30" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Alice" /></label>
            <div className="address-row">
              <label>Server address<input required value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} /></label>
              <label>Port<input required type="number" min="1" max="65535" value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) })} /></label>
            </div>
            <button className="primary" type="submit">Connect</button>
          </form>
          {notice && <p className="notice">{notice}</p>}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <header className="brand"><div className="brand-mark small">R</div><div><strong>Relay</strong><span>Socket chat</span></div></header>
        <section className="profile"><div className="avatar">{initials}</div><div><strong>{connection.name}</strong><span><i /> Connected</span></div></section>

        <section className="nav-section">
          <div className="section-heading"><span>People</span><b>{people.length}</b></div>
          <div className="room-list">
            {people.map((user) => <button type="button" key={user} className={roomKey(activeRoom) === `private:${user}` ? "active" : ""} onClick={() => setActiveRoom({ kind: "private", name: user })}><span className={`mini-avatar ${onlineUsers.has(user) ? "online" : "offline"}`}>{user[0]?.toUpperCase()}</span><span>{user}{user === connection.name ? " (you)" : ""}<small>{onlineUsers.has(user) ? "online" : "offline · history available"}</small></span></button>)}
          </div>
        </section>

        <section className="nav-section groups-section">
          <div className="section-heading"><span>Groups</span><b>{groups.length}</b></div>
          <form className="group-form" onSubmit={createGroup}><input maxLength="40" value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder="New group name" /><button type="submit" title="Create group">+</button></form>
          <div className="room-list">
            {groups.map((group) => <button type="button" key={group.name} className={roomKey(activeRoom) === `group:${group.name}` ? "active" : ""} onClick={() => setActiveRoom({ kind: "group", name: group.name })}><span className="hash">#</span><span><strong>{group.name}</strong><small>{group.members.length} member{group.members.length === 1 ? "" : "s"}</small></span></button>)}
          </div>
        </section>
        <button type="button" className="disconnect" onClick={disconnect}>Disconnect</button>
      </aside>

      <section className="chat-panel">
        {!activeRoom ? (
          <div className="empty-state">
            <div className="empty-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-4 3v-3H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" /><path d="M8 10h8M8 13h5" /></svg>
            </div>
            <h2>Choose a conversation</h2>
            <p>Select a person or group from the sidebar to open its chat room.</p>
          </div>
        ) : (
          <>
            <header className="chat-header">
              {activeRoom.kind === "group"
                ? <span className="hash">#</span>
                : <span className={`mini-avatar ${privatePeerOnline ? "online" : "offline"}`}>{activeRoom.name[0]?.toUpperCase()}</span>}
              <div className="room-title">
                <h2>{activeRoom.name}</h2>
                {activeGroup && <div className="member-chips">{activeGroup.members.map((member) => <span key={member}>{member}</span>)}</div>}
                {activeRoom.kind === "private" && <span className={`presence ${privatePeerOnline ? "online" : ""}`}>{privatePeerOnline ? "online" : "offline"}</span>}
              </div>
              <button type="button" className="summarize" onClick={summarize} disabled={activeSummary?.pending || currentMessages.length === 0}>{activeSummary?.pending ? "Summarizing…" : "Summarize"}</button>
            </header>
            {(activeSummary?.text || activeSummary?.error) && (
              <section className={`summary-card ${activeSummary.error ? "failed" : ""}`} role="status">
                <div><strong>Summary · only you can see this</strong><p>{activeSummary.text || activeSummary.error}</p></div>
                <button type="button" onClick={dismissSummary} aria-label="Dismiss summary">×</button>
              </section>
            )}
            <div className="messages">
              {currentMessages.length === 0 && <div className="conversation-start"><strong>No messages yet</strong><span>Start this conversation.</span></div>}
              {currentMessages.map((message, index) => {
                const mine = message.from === connection.name;
                const bot = message.from === "Chatbot";
                const previous = currentMessages[index - 1];
                const grouped = Boolean(previous)
                  && previous.from === message.from
                  && formatTime(previous.timestamp) === formatTime(message.timestamp)
                  && new Date(message.timestamp) - new Date(previous.timestamp) < 60_000;
                return (
                  <article className={`message ${mine ? "mine" : ""} ${bot ? "bot" : ""} ${!mine && !bot ? "has-avatar" : ""} ${grouped ? "grouped" : ""}`} key={`${message.type}-${message.id || message.timestamp}-${index}`}>
                    {!mine && !bot && !grouped && <span className="mini-avatar message-avatar" aria-hidden="true">{message.from[0]?.toUpperCase()}</span>}
                    {!grouped && <div className="message-meta"><strong>{message.from}</strong><time>{formatTime(message.timestamp)}</time></div>}
                    <div className="bubble">
                      <p>{message.text}</p>
                      <button type="button" className="react-button" aria-label="Add reaction">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M9 10h.01M15 10h.01" /><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" /></svg>
                      </button>
                    </div>
                  </article>
                );
              })}
              <div ref={messageEnd} />
            </div>
            {!privatePeerOnline ? (
              <div className="join-box offline"><p>{activeRoom.name} is offline. Previous messages remain available.</p></div>
            ) : activeGroup && !isMember ? (
              <div className="join-box"><p>You are not a member of this group.</p><button type="button" className="primary" onClick={() => action({ type: "join_group", group: activeGroup.name })}>Join group</button></div>
            ) : (
              <form className="composer" onSubmit={sendMessage}><input autoFocus maxLength="2000" value={messageText} onChange={(e) => setMessageText(e.target.value)} placeholder={`Message ${activeRoom.name}`} /><button className="send" type="submit" disabled={!messageText.trim()}>Send</button></form>
            )}
          </>
        )}
        {notice && <button type="button" className="toast" onClick={() => setNotice("")}>{notice}<span>×</span></button>}
      </section>
    </main>
  );
}

export default App;
