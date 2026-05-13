-- Allow Developer Portal to participate in case messages

ALTER TABLE case_messages
  DROP CONSTRAINT IF EXISTS case_messages_sender_type_check;

ALTER TABLE case_messages
  ADD CONSTRAINT case_messages_sender_type_check
  CHECK (sender_type IN ('client', 'staff', 'developer'));

