alter table communication_email_accounts
  add column if not exists oauth_scopes jsonb not null default '[]'::jsonb;

alter table communication_email_accounts
  add column if not exists signature_html text;

alter table communication_email_accounts
  add column if not exists signature_text text;
