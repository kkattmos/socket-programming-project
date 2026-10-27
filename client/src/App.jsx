import { useEffect, useMemo, useRef, useState } from "react";
import { historyMessages, mergeChatMessages } from "./chatState";

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
        } else if (event.type === "error" || event.type === "connection_error") {
          setNotice(event.message || "A connection error occurred.");
        } else if (event.type === "disconnected") {
          currentName.current = "";
          setConnection((current) => ({ ...current, connected: false }));
          setUsers([]);
          setGroups([]);
          setActiveRoom(null);
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

  useEffect(() => messageEnd.current?.scrollIntoView({ behavior: "smooth" }), [currentMessages.length]);

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
          <p className="eyebrow">TCP SOCKET CHAT</p>
          <h1>Join the conversation.</h1>
          <p className="muted">Connect this computer to the central chat server.</p>
          <form onSubmit={connect} className="login-form">
            <label>Display name<input required maxLength="30" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Alice" /></label>
            <div className="address-row">
              <label>Server address<input required value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} /></label>
              <label>Port<input required type="number" min="1" max="65535" value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) })} /></label>
            </div>
            <button className="primary" type="submit">Connect to chat</button>
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
          <div className="empty-state"><div className="empty-icon">↗</div><h2>Choose a conversation</h2><p>Select a person or group from the sidebar to open its chat room.</p></div>
        ) : (
          <>
            <header className="chat-header">
              <div><p>{activeRoom.kind === "group" ? "GROUP ROOM" : "PRIVATE ROOM"}</p><h2>{activeRoom.kind === "group" ? `# ${activeRoom.name}` : activeRoom.name}</h2></div>
              {activeGroup && <div className="members">{activeGroup.members.join(", ")}</div>}
            </header>
            <div className="messages">
              {currentMessages.length === 0 && <div className="conversation-start"><strong>No messages yet</strong><span>Start this conversation.</span></div>}
              {currentMessages.map((message, index) => {
                const mine = message.from === connection.name;
                return <article className={`message ${mine ? "mine" : ""}`} key={`${message.type}-${message.id || message.timestamp}-${index}`}><div className="message-meta"><strong>{message.from}</strong><time>{formatTime(message.timestamp)}</time></div><p>{message.text}</p></article>;
              })}
              <div ref={messageEnd} />
            </div>
            {!privatePeerOnline ? (
              <div className="join-box"><p>{activeRoom.name} is offline. Previous messages remain available.</p></div>
            ) : activeGroup && !isMember ? (
              <div className="join-box"><p>You are not a member of this group.</p><button type="button" className="primary" onClick={() => action({ type: "join_group", group: activeGroup.name })}>Join group</button></div>
            ) : (
              <form className="composer" onSubmit={sendMessage}><input autoFocus maxLength="2000" value={messageText} onChange={(e) => setMessageText(e.target.value)} placeholder={`Message ${activeRoom.name}`} /><button className="send" type="submit" disabled={!messageText.trim()}>Send <span>↗</span></button></form>
            )}
          </>
        )}
        {notice && <button type="button" className="toast" onClick={() => setNotice("")}>{notice}<span>×</span></button>}
      </section>
    </main>
  );
}

export default App;
