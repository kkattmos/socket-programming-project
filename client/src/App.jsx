import { useEffect, useMemo, useRef, useState } from "react";

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
        setUsers(status.users || []);
        setGroups(status.groups || []);
      } else {
        setConnection((current) => ({ ...current, connected: false }));
      }
    }).catch(() => setNotice("Start the local client bridge to use chat."));

    const events = new EventSource("/api/events");
    events.onmessage = ({ data }) => {
      const event = JSON.parse(data);
      if (event.type === "registered") {
        currentName.current = event.name;
        setConnection((current) => ({ ...current, connected: true, name: event.name }));
        setNotice(`Connected as ${event.name}`);
      } else if (event.type === "state") {
        setUsers(event.users);
        setGroups(event.groups);
      } else if (event.type === "private_message") {
        const peer = event.from === currentName.current ? event.to : event.from;
        const key = `private:${peer}`;
        setMessages((old) => ({ ...old, [key]: [...(old[key] || []), event] }));
      } else if (event.type === "group_message") {
        const key = `group:${event.group}`;
        setMessages((old) => ({ ...old, [key]: [...(old[key] || []), event] }));
      } else if (event.type === "history") {
        setMessages((old) => {
          const next = { ...old };
          for (const message of event.privateMessages) {
            const peer = message.from === currentName.current ? message.to : message.from;
            const key = `private:${peer}`;
            next[key] = [...(next[key] || []), message];
          }
          for (const message of event.groupMessages) {
            const key = `group:${message.group}`;
            next[key] = [...(next[key] || []), message];
          }
          return next;
        });
      } else if (event.type === "error" || event.type === "connection_error") {
        setNotice(event.message);
      } else if (event.type === "disconnected") {
        currentName.current = "";
        setConnection((current) => ({ ...current, connected: false }));
        setUsers([]);
        setGroups([]);
        setActiveRoom(null);
        setNotice("Disconnected from the server.");
      }
    };
    events.onerror = () => setNotice("The browser lost contact with the local client bridge.");
    return () => events.close();
  }, []);

  const currentMessages = messages[roomKey(activeRoom)] || [];
  const activeGroup = activeRoom?.kind === "group" ? groups.find((group) => group.name === activeRoom.name) : null;
  const isMember = activeGroup?.members.includes(connection.name) ?? false;

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
    await request("/api/disconnect", { method: "POST", body: "{}" });
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
          <div className="section-heading"><span>People</span><b>{users.length}</b></div>
          <div className="room-list">
            {users.map((user) => <button key={user} className={roomKey(activeRoom) === `private:${user}` ? "active" : ""} onClick={() => setActiveRoom({ kind: "private", name: user })}><span className="mini-avatar">{user[0].toUpperCase()}</span><span>{user}{user === connection.name ? " (you)" : ""}</span></button>)}
          </div>
        </section>

        <section className="nav-section groups-section">
          <div className="section-heading"><span>Groups</span><b>{groups.length}</b></div>
          <form className="group-form" onSubmit={createGroup}><input maxLength="40" value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder="New group name" /><button title="Create group">+</button></form>
          <div className="room-list">
            {groups.map((group) => <button key={group.name} className={roomKey(activeRoom) === `group:${group.name}` ? "active" : ""} onClick={() => setActiveRoom({ kind: "group", name: group.name })}><span className="hash">#</span><span><strong>{group.name}</strong><small>{group.members.length} member{group.members.length === 1 ? "" : "s"}</small></span></button>)}
          </div>
        </section>
        <button className="disconnect" onClick={disconnect}>Disconnect</button>
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
                return <article className={`message ${mine ? "mine" : ""}`} key={`${message.timestamp}-${index}`}><div className="message-meta"><strong>{message.from}</strong><time>{new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div><p>{message.text}</p></article>;
              })}
              <div ref={messageEnd} />
            </div>
            {activeGroup && !isMember ? (
              <div className="join-box"><p>You are not a member of this group.</p><button className="primary" onClick={() => action({ type: "join_group", group: activeGroup.name })}>Join group</button></div>
            ) : (
              <form className="composer" onSubmit={sendMessage}><input autoFocus maxLength="2000" value={messageText} onChange={(e) => setMessageText(e.target.value)} placeholder={`Message ${activeRoom.name}`} /><button className="send" type="submit" disabled={!messageText.trim()}>Send <span>↗</span></button></form>
            )}
          </>
        )}
        {notice && <button className="toast" onClick={() => setNotice("")}>{notice}<span>×</span></button>}
      </section>
    </main>
  );
}

export default App;
