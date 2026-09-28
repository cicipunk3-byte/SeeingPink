import type { HindsightSourceInput } from '@/lib/thinkpinkBridge';
import type { ChatThread, WikiPage } from '@/lib/localKnowledge';

export function buildHindsightThreadSource(thread: ChatThread): HindsightSourceInput {
  const messages = thread.messages
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
    .join('\n\n');
  return {
    kind: 'thread',
    id: thread.id,
    title: thread.title,
    content: [
      `Thread: ${thread.title}`,
      thread.summary.trim() ? `Summary: ${thread.summary}` : '',
      messages,
    ].filter(Boolean).join('\n\n'),
  };
}

export function buildHindsightWikiSource(page: WikiPage): HindsightSourceInput {
  return {
    kind: 'wiki',
    id: page.id,
    title: page.title,
    content: [
      `Title: ${page.title}`,
      page.category.trim() ? `Category: ${page.category}` : '',
      page.tags.length ? `Tags: ${page.tags.join(', ')}` : '',
      page.body,
    ].filter(Boolean).join('\n\n'),
  };
}