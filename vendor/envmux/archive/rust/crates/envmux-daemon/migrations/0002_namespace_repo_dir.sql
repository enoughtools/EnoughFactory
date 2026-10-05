-- The daemon must be able to rehydrate namespace runtime contexts after a
-- restart without requiring a subsequent `envmux up` from each repository.
ALTER TABLE namespaces ADD COLUMN repo_dir TEXT;
