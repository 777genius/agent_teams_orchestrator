export interface PendingMessageGroup {
  channel_name: string;
  history_key: string;
  group_title?: string;
  message_count: number;
  has_summary: boolean;
  last_activity: string;
}

export interface PendingMessage {
  id: string;
  channel_name: string;
  history_key: string;
  sender: string;
  sender_id: string;
  body: string;
  is_summary: boolean;
  created_at: string;
}
