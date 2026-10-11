import { memo, useContext, useState, useEffect } from 'react';
import { MessageActionsContext, NavContext } from '../state';
import { formatShortTime, formatFull, formatDayPill } from '../../shared/format';
import MessageContent, { OwnMessageContext } from './MessageContent.jsx';
import { ReplyQuote, Reactions, Embeds, ThreadChip, MessageActionBar, PollCard } from './MessageExtras.jsx';
import { hueFor } from './ChatList.jsx';
import { systemInfo } from '../../shared/system-messages';
import MediaGate from './MediaGate.jsx';
import { openProfile } from './ProfileCard.jsx';
import { prefs } from '../prefs';
import { checkLink, checkMessageLinks } from '../../shared/link-safety';
import { getLists } from '../linkLists';
import { attachmentKind } from '../../shared/media';

function Avatar({ author }) {
  const [broken, setBroken] = useState(false);
  if (!author.avatarUrl || broken) {
    const hue = hueFor(author.id);
    return (
      <div className="avatar avatar--placeholder" style={{ background: `linear-gradient(135deg, hsl(${hue} 55% 42%), hsl(${(hue + 40) % 360} 60% 30%))` }}>
        {author.name.slice(0, 1).toUpperCase()}
      </div>
    );
  }
  return <img className="avatar" src={author.avatarUrl} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />;
}

// #86: Knöpfe/Auswahlmenüs einer Nachricht ANZEIGEN. Fremde Knöpfe kann ein Bot nicht drücken (Discord-Grenze),
// darum nur Ansicht. Link-Knöpfe sind echte Links und öffnen über den normalen Link-Schutz im Browser.
const BTN_STYLE = { 1: 'primary', 2: 'secondary', 3: 'success', 4: 'danger', 5: 'link' };
// Emoji eines Knopfs: eigenes Server-Emoji als Bild, sonst Unicode-Zeichen
function BtnEmoji({ c }) {
  if (c.emojiUrl) return <img className="msg-btn__emoji" src={c.emojiUrl} alt={c.emoji || ''} draggable={false} />;
  return c.emoji ? <span className="msg-btn__emoji">{c.emoji}</span> : null;
}
function MessageButtons({ rows }) {
  const nav = useContext(NavContext);
  if (!rows?.length) return null;
  const openLink = (url) => {
    const check = checkLink(url, prefs.get().trustedDomains, getLists());
    if (check.level === 'danger') return; // gefährliche Link-Knöpfe nicht öffnen
    nav.openExternal(url);
  };
  const needHint = rows.some((r) => r.components.some((c) => c.kind === 'select' || (c.kind === 'button' && !c.url)));
  return (
    <div className="msg-buttons">
      {rows.map((row, ri) => (
        <div className="msg-buttons__row" key={ri}>
          {row.components.map((c, ci) =>
            c.kind === 'select' ? (
              <span className="msg-btn msg-btn--select" key={ci} title="Auswahlmenü – bedient nur ein Nutzer im Discord-Client">
                ▾ {c.placeholder}
              </span>
            ) : c.url ? (
              <button className={`msg-btn msg-btn--${BTN_STYLE[c.style] || 'secondary'} msg-btn--link`} key={ci} onClick={() => openLink(c.url)} title={`${c.url} (öffnet im Browser)`}>
                <BtnEmoji c={c} />
                {c.label || (c.emoji ? '' : 'Link')} ↗
              </button>
            ) : (
              <span className={`msg-btn msg-btn--${BTN_STYLE[c.style] || 'secondary'} msg-btn--ro${c.disabled ? ' is-disabled' : ''}`} key={ci} title={`${c.label || c.emoji || 'Knopf'} – kann nur ein Nutzer im Discord-Client drücken`}>
                <BtnEmoji c={c} />
                {/* #129: nur-Emoji-Knöpfe ohne angehängtes „Knopf“ */}
                {c.label || (c.emoji ? '' : 'Knopf')}
              </span>
            ),
          )}
        </div>
      ))}
      {needHint && <span className="msg-buttons__hint muted small">Knöpfe anderer Apps kann nur ein Nutzer im Discord-Client drücken.</span>}
    </div>
  );
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

function Attachments({ items }) {
  if (!items?.length) return null;
  return (
    <div className="attachments">
      {items.map((a) => {
        const kind = attachmentKind(a);
        const ratio = a.width && a.height ? { aspectRatio: `${a.width} / ${a.height}` } : undefined;
        if (kind === 'video')
          return (
            <MediaGate key={a.id} kind="video" name={a.name}>
              <video className="attachment-img" src={a.url} controls preload="metadata" playsInline style={ratio} />
            </MediaGate>
          );
        return kind ? (
          <MediaGate key={a.id} kind={kind} name={a.name}>
            <img className="attachment-img" src={a.url} alt={a.name} loading="lazy" decoding="async" style={ratio} />
          </MediaGate>
        ) : (
          <div key={a.id} className="attachment-file">
            📎 {a.name} <span className="muted small">({formatSize(a.size)})</span>
          </div>
        );
      })}
    </div>
  );
}

export const DayDivider = memo(function DayDivider({ timestamp }) {
  return (
    <div className="day-pill" role="separator">
      <span>{formatDayPill(timestamp)}</span>
    </div>
  );
});

// Häkchen: ✓ = bei Discord angekommen. (Lesebestätigungen gibt es bei Discord nicht.)
function Tick({ m }) {
  if (m.pending) return <span className="tick tick--pending" title="Wird gesendet …">🕓</span>;
  if (m.failed) return <span className="tick tick--failed" title="Nicht gesendet">!</span>;
  return (
    <span className="tick" title="Gesendet">
      ✓
    </span>
  );
}

// Systemnachricht (Beitritt, Boost, Pin …): mittig als Hinweis statt als Sprechblase
function SystemRow({ m, highlighted }) {
  const info = systemInfo(m) || { icon: 'ℹ️', text: 'Systemnachricht von Discord.' };
  return (
    <div className={`msg msg--system ${highlighted ? 'msg--highlight' : ''}`} data-mid={m.id} role="note">
      <span className="sysmsg">
        <span aria-hidden="true">{info.icon}</span> {info.text}
        <span className="sysmsg__time">{formatShortTime(m.createdTimestamp)}</span>
      </span>
    </div>
  );
}

// Warnung bei gefährlichen Links in fremden Nachrichten (Issue #38); „Für mich ausblenden“ wird empfohlen
function LinkAlarm({ m, actions }) {
  const danger = checkMessageLinks(m.content, prefs.get().trustedDomains, getLists()).filter((x) => x.level === 'danger');
  if (!danger.length) return null;
  return (
    <div className="link-alarm" role="alert">
      <b>⛔ Achtung: gefährlicher Link</b>
      <span>{danger[0].reasons[0]}</span>
      <span className="muted small">Bitte nicht anklicken. Der Link ist hier gesperrt und lässt sich nicht kopieren.</span>
      <span className="link-alarm__actions">
        <button className="btn btn--primary btn--small" onClick={() => hideMessage(m.id)}>
          🙈 Für mich ausblenden (empfohlen)
        </button>
        {m.canDelete && (
          <button className="btn btn--danger btn--small" onClick={() => actions?.remove?.(m)}>
            🗑 Für alle löschen
          </button>
        )}
      </span>
    </div>
  );
}

function hideMessage(id) {
  prefs.set({ hiddenMessages: [...prefs.get().hiddenMessages.filter((x) => x !== id), id].slice(-500) });
}

function useHidden(id) {
  const [hidden, setHidden] = useState(() => prefs.get().hiddenMessages.includes(id));
  useEffect(() => prefs.subscribe((p) => setHidden(p.hiddenMessages.includes(id))), [id]);
  return hidden;
}

function MessageItem({ message: m, grouped, highlighted, onRetry, onDiscard }) {
  const actions = useContext(MessageActionsContext);
  const hidden = useHidden(m.id);
  if (m.system && !m.pending) return <SystemRow m={m} highlighted={highlighted} />;
  if (hidden)
    return (
      <div className="msg msg--in msg--hidden" data-mid={m.id}>
        <span className="avatar-spacer" />
        <div className="msg-hidden">
          🙈 Ausgeblendete Nachricht von {m.author.name} (gefährlicher Link) ·{' '}
          <button className="linklike" onClick={() => prefs.set({ hiddenMessages: prefs.get().hiddenMessages.filter((x) => x !== m.id) })}>
            wieder zeigen
          </button>
        </div>
      </div>
    );
  const out = m.isOwn || m.pending || m.failed;
  const cls = ['msg', out ? 'msg--out' : 'msg--in', grouped && 'msg--grouped', m.pending && 'msg--pending', m.failed && 'msg--failed', highlighted && 'msg--highlight', m.mentions?.everyone && 'msg--mass']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cls} data-mid={m.id} onContextMenu={(e) => actions?.contextMenu?.(e, m)}>
      {!out &&
        (grouped ? (
          <span className="avatar-spacer" />
        ) : (
          <button className="avatar-btn" onClick={() => !m.system && openProfile(m.author.id, m.guildId)} aria-label={`Profil von ${m.author.name}`} title="Profil anzeigen">
            <Avatar author={m.author} />
          </button>
        ))}
      <div className={`bubble ${grouped ? '' : 'bubble--tail'}`}>
        <MessageActionBar message={m} out={out} />
        <ReplyQuote reference={m.reference} />
        {!out && !grouped && (
          <div className="bubble__author" style={{ color: m.author.color || `hsl(${hueFor(m.author.id)} 70% var(--author-l, 68%))` }}>
            <button className="linklike bubble__author-btn" onClick={() => openProfile(m.author.id, m.guildId)} title="Profil anzeigen">
              {m.author.name}
            </button>
            {m.author.bot && <span className="bot-tag">BOT</span>}
          </div>
        )}
        <OwnMessageContext.Provider value={Boolean(out)}>
          <MessageContent content={m.content} mentions={m.mentions} />
        </OwnMessageContext.Provider>
        {!out && <LinkAlarm m={m} actions={actions} />}
        <Attachments items={m.attachments} />
        <PollCard message={m} />
        <Embeds embeds={m.embeds} mentions={m.mentions} />
        <MessageButtons rows={m.components} />
        <ThreadChip thread={m.thread} />
        <span className="bubble__meta" title={formatFull(m.createdTimestamp)}>
          {m.pinned && <span title="Angeheftet">📌 </span>}
          {m.editedTimestamp && <span title={`Bearbeitet: ${formatFull(m.editedTimestamp)}`}>bearbeitet · </span>}
          {formatShortTime(m.createdTimestamp)}
          {out && <Tick m={m} />}
        </span>
        <Reactions message={m} />
      </div>
      {m.failed && (
        <div className="msg__failed">
          <span>Nicht gesendet: {m.error?.message}</span>
          {m.error?.hint && <span className="muted small">Was kann ich tun? {m.error.hint}</span>}
          <span className="msg__failed-actions">
            <button className="btn btn--small" onClick={() => onRetry(m)}>
              Erneut senden
            </button>
            <button className="btn btn--small btn--ghost" onClick={() => onDiscard(m)}>
              Verwerfen
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

export default memo(MessageItem);
