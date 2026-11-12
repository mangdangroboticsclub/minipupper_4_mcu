<script>
  import { deleteConversation, listConversations, setConversationArchived } from "../conversationStore.js";

  let {
    activeId,
    onSelect,
    onNew,
    onDelete,
    refreshKey = 0,
  } = $props();

  let conversations = $state([]);
  let searchText = $state("");
  let showArchived = $state(false);

  function refresh() {
    conversations = listConversations();
  }

  $effect(() => {
    refreshKey;
    refresh();
  });

  /** Group conversations by date category */
  function getDateLabel(ts) {
    const d = new Date(ts);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dateDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDays = Math.round((today - dateDay) / 86400000);

    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return "Earlier this week";
    return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  }

  /** Group conversations by category */
  let grouped = $derived.by(() => {
    const visible = conversations.filter((c) => !c.archived);
    const list = searchText.trim()
      ? visible.filter((c) =>
          c.title.toLowerCase().includes(searchText.toLowerCase())
        )
      : visible;

    const groups = {};
    for (const c of list) {
      const label = getDateLabel(c.updatedAt);
      if (!groups[label]) groups[label] = [];
      groups[label].push(c);
    }
    return groups;
  });

  let archived = $derived(conversations.filter((c) => c.archived &&
    (!searchText.trim() || c.title.toLowerCase().includes(searchText.toLowerCase()))));

  function handleArchive(convo, e) {
    e.stopPropagation();
    const next = !convo.archived;
    setConversationArchived(convo.id, next);
    window.dispatchEvent(new CustomEvent("mpx-conversation-archive", {
      detail: { id: convo.id, archived: next },
    }));
    refresh();
  }

  function handleDelete(convo, e) {
    e.stopPropagation();
    if (convo.source === "voice" && !window.confirm(
      "Remove this voice chat from this phone? The robot transcript and agent memory stay."
    )) return;
    deleteConversation(convo.id);
    refresh();
    if (activeId === convo.id) onDelete?.(convo.id);
  }
</script>

{#snippet conversationRow(convo)}
  <button
    class="convo-item"
    class:active={convo.id === activeId}
    onclick={() => onSelect?.(convo.id)}
  >
    <div class="convo-content">
      <p class="convo-title">
        <span class="brain-badge" class:local={convo.brain === "local"} title={convo.source === "voice" ? "Voice chat answered by Pupper" : convo.brain === "local" ? "Answered by Pupper (on the robot)" : "Answered by the Cloud"}>
          {convo.source === "voice" ? "Voice" : convo.brain === "local" ? "Pupper" : "Cloud"}
        </span>
        {convo.title}
        {#if convo.unread}<span class="unread-badge" aria-label="{convo.unread} unread turns">{convo.unread}</span>{/if}
      </p>
      {#if convo.messages?.length}
        <p class="convo-preview">{convo.messages[convo.messages.length - 1]?.text?.slice(0, 80)}</p>
      {/if}
    </div>
    <div class="convo-meta">
      <span class="convo-time">{formatTime(convo.updatedAt)}</span>
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <span class="delete-btn" onclick={(e) => handleArchive(convo, e)} aria-label={convo.archived ? "Unarchive" : "Archive"} title={convo.archived ? "Unarchive" : "Archive"}>
        {convo.archived ? "↥" : "↓"}
      </span>
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <span class="delete-btn" onclick={(e) => handleDelete(convo, e)} aria-label="Delete">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </span>
    </div>
  </button>
{/snippet}

<div class="sidebar">
  <!-- Header -->
  <div class="sidebar-header">
    <h2 class="sidebar-title">History</h2>
    <button type="button" class="new-btn" onclick={onNew} aria-label="New conversation">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
        <path d="M12 5v14M5 12h14"/>
      </svg>
    </button>
  </div>

  <!-- Search -->
  <label class="search-box">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>
    </svg>
    <input
      type="search"
      bind:value={searchText}
      placeholder="Search conversations"
      aria-label="Search conversations"
      class="search-input"
    />
  </label>

  <!-- Conversation list -->
  <div class="convo-list">
    {#if Object.keys(grouped).length === 0}
      <p class="empty-msg">{searchText ? "No matching conversations." : "No conversations yet."}</p>
    {:else}
      {#each Object.entries(grouped) as [label, convos]}
        <div class="group">
          <span class="group-label">{label}</span>
          {#each convos as convo (convo.id)}
            {@render conversationRow(convo)}
          {/each}
        </div>
      {/each}
    {/if}
    {#if archived.length}
      <button class="archive-toggle" type="button" aria-expanded={showArchived} onclick={() => (showArchived = !showArchived)}>
        Archived ({archived.length}) {showArchived ? "▾" : "▸"}
      </button>
      {#if showArchived}
        {#each archived as convo (convo.id)}
          {@render conversationRow(convo)}
        {/each}
      {/if}
    {/if}
  </div>
</div>

<script context="module">
  function formatTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now - d;
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffDays === 0) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }
</script>

<style>
  .sidebar {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--page);
    color: var(--ink);
    border-right: 1px solid var(--line);
    flex-shrink: 0;
  }

  .sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: calc(18px + var(--safe-top)) 16px 12px 20px;
  }

  .sidebar-title {
    font-size: 26px;
    font-weight: 800;
    letter-spacing: -0.02em;
  }

  .new-btn {
    width: 44px;
    height: 44px;
    border-radius: 22px;
    border: none;
    background: var(--ink);
    color: var(--mpx-yellow);
    cursor: pointer;
    display: grid;
    place-items: center;
  }

  .search-box {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 46px;
    margin: 0 16px 8px;
    padding: 0 14px;
    border-radius: 23px;
    background: var(--ground);
    color: var(--sub);
  }
  .search-box:focus-within { outline: 3px solid var(--ink); outline-offset: 2px; }

  .search-input {
    flex: 1;
    min-width: 0;
    border: none;
    outline: none;
    background: transparent;
    font-size: 16px;
    color: var(--ink);
  }
  .search-input::placeholder { color: var(--sub); }

  .convo-list {
    flex: 1;
    overflow-y: auto;
    padding: 0 10px calc(16px + var(--safe-bottom));
  }

  .archive-toggle {
    width: 100%;
    padding: 14px 10px 8px;
    border: 0;
    background: none;
    color: var(--sub);
    text-align: left;
    font-size: 12px;
    font-weight: 800;
    cursor: pointer;
  }
  .unread-badge {
    display: inline-grid;
    place-items: center;
    min-width: 18px;
    height: 18px;
    margin-left: 4px;
    border-radius: 9px;
    background: var(--mpx-yellow);
    color: var(--ink);
    font-size: 10px;
  }

  .group {
    margin-bottom: 6px;
  }

  .group-label {
    display: block;
    font-size: 12px;
    font-weight: 800;
    color: var(--sub);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    padding: 12px 10px 6px;
  }

  .convo-item {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-radius: 16px;
    padding: 10px 12px;
    color: var(--ink);
    cursor: pointer;
    transition: background var(--dur-fast);
  }
  .convo-item:hover {
    background: var(--ground);
  }
  .convo-item.active {
    background: #FFF6B0;
  }
  .convo-item:focus-visible { outline: 3px solid var(--ink); outline-offset: -3px; }

  .convo-content {
    flex: 1;
    min-width: 0;
  }

  .convo-title {
    font-size: 15px;
    font-weight: 700;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .convo-preview {
    font-size: 13px;
    color: var(--sub);
    margin-top: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .brain-badge {
    display: inline-block;
    margin-right: 6px;
    padding: 2px 7px;
    border-radius: 8px;
    background: var(--ground);
    color: var(--sub);
    font-size: 11px;
    font-weight: 700;
    vertical-align: 1px;
  }
  .brain-badge.local { background: var(--mpx-yellow); color: var(--ink); }

  .convo-meta {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
    flex-shrink: 0;
  }

  .convo-time {
    font-size: 12px;
    color: var(--sub);
  }

  .delete-btn {
    width: 26px;
    height: 26px;
    border-radius: 13px;
    display: grid;
    place-items: center;
    color: #A39F96;
    transition: background var(--dur-fast), color var(--dur-fast), opacity var(--dur-fast);
    opacity: 0;
  }
  .convo-item:hover .delete-btn,
  .convo-item.active .delete-btn {
    opacity: 1;
  }
  @media (hover: none) { .delete-btn { opacity: 1; } }
  .delete-btn:hover {
    background: #FBE4E0;
    color: #9B2C20;
  }

  .empty-msg {
    font-size: 14px;
    color: var(--sub);
    text-align: center;
    padding: 40px 14px;
  }
</style>
