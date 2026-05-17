BEGIN;

INSERT INTO document_variable_definitions
  (key, label, description, category, value_type, source_path, formatter, example_value, is_system, is_active, sort_order, updated_at)
VALUES
  ('is_joint_purchaser','Is Joint Purchaser','True if more than one purchaser','purchaser','boolean','is_joint_purchaser',NULL,NULL,TRUE,TRUE,246,now()),
  ('purchaser_pronoun','Purchaser Pronoun','I / We based on purchaser count','purchaser','string','purchaser_pronoun',NULL,'We',TRUE,TRUE,247,now()),
  ('purchaser_verb','Purchaser Verb','am / are based on purchaser count','purchaser','string','purchaser_verb',NULL,'are',TRUE,TRUE,248,now())
ON CONFLICT (key) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  value_type = EXCLUDED.value_type,
  source_path = EXCLUDED.source_path,
  formatter = EXCLUDED.formatter,
  example_value = EXCLUDED.example_value,
  is_system = TRUE,
  is_active = TRUE,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

COMMIT;

