import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import Editor from '@monaco-editor/react';
import {
  Code2,
  Users,
  ScrollText,
  Lock,
  Unlock,
  Crown,
  Copy,
  Check,
  LogOut,
  AlertTriangle,
  Radio,
  Trash2,
  Sparkles,
  Wifi,
  WifiOff
} from 'lucide-react';
import './App.css';

const SOCKET_SERVER_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:4000'
  : `${window.location.protocol}//${window.location.hostname}:4000`;

const COLOR_PRESETS = [
  '#3b82f6', // blue
  '#10b981', // green
  '#8b5cf6', // purple
  '#f59e0b', // amber
  '#ec4899', // pink
  '#06b6d4', // cyan
];

const LANGUAGES = [
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'python', label: 'Python' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'json', label: 'JSON' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'cpp', label: 'C++' },
];

export default function App() {
  // --- Lobby State ---
  const [inRoom, setInRoom] = useState(false);
  const [roomIdInput, setRoomIdInput] = useState('');
  const [passcodeInput, setPasscodeInput] = useState('');
  const [usernameInput, setUsernameInput] = useState('');
  const [userColor, setUserColor] = useState(COLOR_PRESETS[0]);
  const [joinError, setJoinError] = useState('');
  const [isJoining, setIsJoining] = useState(false);

  // --- Active Room State ---
  const [roomData, setRoomData] = useState(null);
  const [members, setMembers] = useState([]);
  const [auditLog, setAuditLog] = useState([]);
  const [language, setLanguage] = useState('javascript');
  const [isHost, setIsHost] = useState(false);
  const [typingMap, setTypingMap] = useState({}); // socketId -> boolean
  const [throttleWarning, setThrottleWarning] = useState(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('connecting'); // connected | reconnecting | disconnected

  // --- Editor & Socket Refs ---
  const socketRef = useRef(null);
  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const isRemoteChangeRef = useRef(false);
  const typingTimeoutRef = useRef(null);
  const decorationsRef = useRef([]);
  const auditBottomRef = useRef(null);

  // Auto-scroll audit feed when new items arrive
  useEffect(() => {
    if (auditBottomRef.current) {
      auditBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [auditLog]);

  // Connect to room handler
  const handleJoin = (e) => {
    e?.preventDefault();
    if (!roomIdInput.trim() || !usernameInput.trim()) {
      setJoinError('Please provide both Room ID and Username.');
      return;
    }

    setIsJoining(true);
    setJoinError('');

    // Initialize Socket connection
    const socket = io(SOCKET_SERVER_URL, {
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnectionStatus('connected');
      // Perform handshake & validation
      socket.emit('join_room', {
        roomId: roomIdInput.trim(),
        passcode: passcodeInput.trim(),
        username: usernameInput.trim(),
        color: userColor
      }, (res) => {
        setIsJoining(false);
        if (!res?.success) {
          setJoinError(res?.error || 'Failed to join room.');
          socket.disconnect();
          return;
        }

        // Successfully joined room
        setRoomData(res.room);
        setMembers(res.room.members || []);
        setAuditLog(res.room.auditLog || []);
        setLanguage(res.room.language || 'javascript');
        setIsHost(res.room.isHost);
        setInRoom(true);
      });
    });

    socket.on('disconnect', () => {
      setConnectionStatus('disconnected');
    });

    socket.on('reconnect_attempt', () => {
      setConnectionStatus('reconnecting');
    });

    socket.on('reconnect', () => {
      setConnectionStatus('connected');
      // Re-join upon reconnect
      socket.emit('join_room', {
        roomId: roomIdInput.trim(),
        passcode: passcodeInput.trim(),
        username: usernameInput.trim(),
        color: userColor
      }, (res) => {
        if (res?.success) {
          setMembers(res.room.members);
          setIsHost(res.room.isHost);
        }
      });
    });

    // Real-time synchronization events
    socket.on('code_change', ({ fullCode }) => {
      if (!editorRef.current) return;
      const model = editorRef.current.getModel();
      if (!model) return;

      const currentVal = model.getValue();
      if (currentVal !== fullCode) {
        isRemoteChangeRef.current = true;
        // Apply remote text update preserving cursor position
        const state = editorRef.current.saveViewState();
        model.setValue(fullCode);
        if (state) editorRef.current.restoreViewState(state);
        isRemoteChangeRef.current = false;
      }
    });

    socket.on('code_cleared', () => {
      if (!editorRef.current) return;
      isRemoteChangeRef.current = true;
      editorRef.current.getModel().setValue('');
      isRemoteChangeRef.current = false;
    });

    socket.on('language_changed', ({ language: newLang }) => {
      setLanguage(newLang);
    });

    socket.on('members_updated', (updatedMembers) => {
      setMembers(updatedMembers);
      // Check if current user is host
      const me = updatedMembers.find(m => m.socketId === socket.id);
      if (me) {
        setIsHost(!!me.isHost);
      }
    });

    socket.on('host_reassigned', ({ newHostSocketId, newHostUsername }) => {
      setIsHost(socket.id === newHostSocketId);
    });

    socket.on('peer_cursor_update', ({ socketId, cursor, selection }) => {
      updatePeerDecorations(socketId, cursor, selection);
    });

    socket.on('peer_typing_status', ({ socketId, isTyping }) => {
      setTypingMap(prev => ({ ...prev, [socketId]: isTyping }));
    });

    socket.on('audit_log_entry', (entry) => {
      setAuditLog(prev => [...prev, entry]);
    });

    socket.on('throttle_warning', ({ message }) => {
      setThrottleWarning(message);
      setTimeout(() => setThrottleWarning(null), 3000);
    });

    socket.on('error_notification', (msg) => {
      alert(msg);
    });
  };

  // Helper to update remote cursor overlays and line highlights in Monaco
  const updatePeerDecorations = (peerSocketId, cursor, selection) => {
    if (!editorRef.current || !monacoRef.current) return;
    const peer = members.find(m => m.socketId === peerSocketId);
    if (!peer || !cursor) return;

    const monaco = monacoRef.current;
    const newDecorations = [];

    // Line Highlight for peer's active position
    newDecorations.push({
      range: new monaco.Range(cursor.lineNumber, 1, cursor.lineNumber, 1),
      options: {
        isWholeLine: true,
        className: 'remote-cursor-line',
      }
    });

    // Remote Cursor Caret & Name Tag
    newDecorations.push({
      range: new monaco.Range(cursor.lineNumber, cursor.column, cursor.lineNumber, cursor.column),
      options: {
        className: 'remote-cursor-caret',
        before: {
          content: ` ${peer.username} `,
          inlineClassName: 'remote-cursor-tag',
          inlineClassNameAffectsLetterSpacing: true
        }
      }
    });

    decorationsRef.current = editorRef.current.deltaDecorations(decorationsRef.current, newDecorations);
  };

  // Editor Mount Handler
  const handleEditorDidMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    if (roomData?.code) {
      editor.setValue(roomData.code);
    }

    // Broadcast cursor & selection changes
    editor.onDidChangeCursorPosition((e) => {
      if (socketRef.current && socketRef.current.connected) {
        socketRef.current.emit('cursor_move', {
          cursor: { lineNumber: e.position.lineNumber, column: e.position.column },
          selection: editor.getSelection()
        });
      }
    });
  };

  // Editor Content Change Handler (Local Typing)
  const handleEditorChange = (value) => {
    if (isRemoteChangeRef.current) return;
    if (!socketRef.current || !socketRef.current.connected) return;

    // Send code change
    socketRef.current.emit('code_change', {
      change: null,
      fullCode: value || ''
    });

    // Broadcast Typing Indicator
    socketRef.current.emit('typing_status', { isTyping: true });
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      if (socketRef.current && socketRef.current.connected) {
        socketRef.current.emit('typing_status', { isTyping: false });
      }
    }, 1200);
  };

  // Language Change
  const handleLanguageChange = (e) => {
    const newLang = e.target.value;
    setLanguage(newLang);
    if (socketRef.current && socketRef.current.connected) {
      socketRef.current.emit('language_change', { language: newLang });
    }
  };

  // Host Action: Clear workspace
  const handleClearPad = () => {
    if (!isHost) return;
    if (window.confirm('Are you sure you want to clear the entire pad? This affects all peers.')) {
      socketRef.current?.emit('host_clear_pad');
    }
  };

  // Leave Room
  const handleLeaveRoom = () => {
    if (socketRef.current) {
      socketRef.current.disconnect();
    }
    setInRoom(false);
    setRoomData(null);
    setMembers([]);
    setAuditLog([]);
  };

  // Copy Room Link / ID
  const handleCopyRoomId = () => {
    navigator.clipboard.writeText(roomData?.id || roomIdInput);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  // Generate random room ID helper
  const handleGenerateRoomId = () => {
    const rand = 'room-' + Math.random().toString(36).substring(2, 8);
    setRoomIdInput(rand);
  };

  // --- Render Lobby Screen ---
  if (!inRoom) {
    return (
      <div className="lobby-backdrop">
        <div className="lobby-card slide-down">
          <div className="lobby-header">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 8 }}>
              <Code2 size={32} color="#3b82f6" />
              <h1>Live Collaborative Code Pad</h1>
            </div>
            <p>Real-time collaborative code editor with instant sync & presence</p>
          </div>

          {joinError && (
            <div className="error-banner">
              <AlertTriangle size={16} />
              <span>{joinError}</span>
            </div>
          )}

          <form onSubmit={handleJoin} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="form-group">
              <label className="form-label">Room ID</label>
              <div className="input-row">
                <input
                  type="text"
                  className="text-input"
                  placeholder="e.g. cs101-algorithms"
                  value={roomIdInput}
                  onChange={(e) => setRoomIdInput(e.target.value)}
                  required
                />
                <button
                  type="button"
                  className="btn-icon-addon"
                  title="Generate Random Room ID"
                  onClick={handleGenerateRoomId}
                >
                  <Sparkles size={16} />
                </button>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Room Passcode (Optional)</label>
              <input
                type="password"
                className="text-input"
                placeholder="Leave blank for open public room"
                value={passcodeInput}
                onChange={(e) => setPasscodeInput(e.target.value)}
              />
            </div>

            <div className="form-group">
              <label className="form-label">Your Display Name</label>
              <input
                type="text"
                className="text-input"
                placeholder="e.g. Alice Developer"
                value={usernameInput}
                onChange={(e) => setUsernameInput(e.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <label className="form-label">Select Your Presence Color</label>
              <div className="color-presets">
                {COLOR_PRESETS.map((color) => (
                  <div
                    key={color}
                    className={`color-dot ${userColor === color ? 'active' : ''}`}
                    style={{ backgroundColor: color }}
                    onClick={() => setUserColor(color)}
                  />
                ))}
              </div>
            </div>

            <button type="submit" className="btn-primary" disabled={isJoining}>
              {isJoining ? 'Verifying & Joining...' : 'Enter Workspace'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // Current host details
  const currentHost = members.find(m => m.isHost);

  // --- Render Active Workspace ---
  return (
    <div className="app-container">
      {/* Top Header */}
      <header className="app-header">
        <div className="header-left">
          <div className="brand-badge">
            <Code2 size={20} color="#3b82f6" />
            <span>CodePad Live</span>
          </div>

          <div className="room-pill">
            <span>#{roomData?.id}</span>
            <button className="copy-btn" onClick={handleCopyRoomId} title="Copy Room ID">
              {copiedLink ? <Check size={14} color="#10b981" /> : <Copy size={14} />}
            </button>
          </div>

          {roomData?.hasPasscode ? (
            <span className="tag-badge secure">
              <Lock size={12} /> Protected
            </span>
          ) : (
            <span className="tag-badge public">
              <Unlock size={12} /> Public
            </span>
          )}

          {currentHost && (
            <span className="tag-badge host">
              <Crown size={12} /> Host: {currentHost.username}
            </span>
          )}
        </div>

        <div className="header-center">
          <select
            className="select-dropdown"
            value={language}
            onChange={handleLanguageChange}
          >
            {LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>{l.label}</option>
            ))}
          </select>
        </div>

        <div className="header-right">
          <div className="status-pill">
            {connectionStatus === 'connected' ? (
              <>
                <Wifi size={14} color="#10b981" />
                <span style={{ color: '#10b981' }}>Connected</span>
              </>
            ) : connectionStatus === 'reconnecting' ? (
              <>
                <Radio size={14} color="#f59e0b" className="pulsing-dot" />
                <span style={{ color: '#f59e0b' }}>Reconnecting...</span>
              </>
            ) : (
              <>
                <WifiOff size={14} color="#ef4444" />
                <span style={{ color: '#ef4444' }}>Disconnected</span>
              </>
            )}
          </div>

          <button className="btn-secondary" onClick={handleLeaveRoom} title="Leave Room">
            <LogOut size={14} /> Leave
          </button>
        </div>
      </header>

      {/* Main Split Layout */}
      <main className="workspace-body">
        {/* Left Side: Synchronized Code Editor */}
        <section className="editor-panel">
          {throttleWarning && (
            <div className="throttle-alert slide-down">
              <AlertTriangle size={16} />
              <span>{throttleWarning}</span>
            </div>
          )}

          <div className="editor-wrapper">
            <Editor
              height="100%"
              language={language}
              theme="vs-dark"
              onMount={handleEditorDidMount}
              onChange={handleEditorChange}
              options={{
                fontSize: 14,
                fontFamily: "'Fira Code', 'Cascadia Code', Consolas, monospace",
                lineNumbers: 'on',
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                automaticLayout: true,
                tabSize: 2,
                wordWrap: 'on',
                renderWhitespace: 'selection',
                smoothScrolling: true,
              }}
            />
          </div>

          <div className="editor-statusbar">
            <span>UTF-8 • {language.toUpperCase()}</span>
            <span>Live Sync Active • 5 ops/s Spam Protected</span>
          </div>
        </section>

        {/* Right Side: Split Sidebar */}
        <aside className="sidebar-panel">
          {/* Top Half: Participant List */}
          <div className="participants-section">
            <div className="section-header">
              <div className="section-title">
                <Users size={14} /> Active Peers
                <span className="count-badge">{members.length}</span>
              </div>
              {isHost && (
                <button
                  className="btn-danger"
                  onClick={handleClearPad}
                  title="Host Control: Clear code for all peers"
                >
                  <Trash2 size={12} /> Clear Pad
                </button>
              )}
            </div>

            <div className="participants-list">
              {members.map((member) => {
                const isMe = member.socketId === socketRef.current?.id;
                const isTyping = typingMap[member.socketId];

                return (
                  <div key={member.socketId} className="participant-item">
                    <div className="participant-left">
                      <div
                        className="avatar-circle"
                        style={{ backgroundColor: member.color || '#3b82f6' }}
                      >
                        {member.username.charAt(0).toUpperCase()}
                        <div className="presence-dot" />
                      </div>
                      <span className="participant-name">
                        {member.username}
                        {isMe && <span className="you-tag">(You)</span>}
                        {member.isHost && (
                          <Crown size={13} color="#f59e0b" title="Room Host" />
                        )}
                      </span>
                    </div>

                    {isTyping && (
                      <span className="typing-badge pulsing-dot">
                        typing...
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Bottom Half: Live Activity Audit Feed */}
          <div className="audit-section">
            <div className="section-header">
              <div className="section-title">
                <ScrollText size={14} /> Activity Feed
              </div>
            </div>

            <div className="audit-feed">
              {auditLog.map((log) => (
                <div key={log.id} className={`audit-entry ${log.type}`}>
                  <div className="audit-meta">
                    <span style={{ fontWeight: 600 }}>{log.type.toUpperCase()}</span>
                    <span>{log.timestamp}</span>
                  </div>
                  <div className="audit-text">{log.text}</div>
                </div>
              ))}
              <div ref={auditBottomRef} />
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}
