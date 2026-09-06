// Phase 0 projections, not a claim of generated full-schema types. db:types needs the local stack.
import type { Language } from '../i18n';
import type { Category } from '../domain/wardrobe';

export type ProfileRow = {
  owner_id: string; display_name: string; ui_language: Language | null;
  timezone: string; currency: string; version: number;
};
export type ItemRow = {
  id: string; owner_id: string; title: string; category: Category;
  currency: string; deleted_at: string | null; created_at: string; version: number;
};
export type ImageRow = {
  id: string; owner_id: string; item_id: string; state: 'pending' | 'ready' | 'retired';
  main_path: string; thumb_path: string; main_bytes: number; thumb_bytes: number;
  main_sha256: string; thumb_sha256: string; width: number; height: number; alt_text: string;
};
type Table<Row, Insert, Update> = { Row: Row; Insert: Insert; Update: Update; Relationships: [] };
type Empty = Record<never, never>;
export type PhaseZeroDatabase = {
  public: {
    Tables: {
      profiles: Table<ProfileRow, never, { ui_language?: Language; display_name?: string }>;
      items: Table<ItemRow, Pick<ItemRow, 'id' | 'owner_id' | 'title' | 'category' | 'currency'>, never>;
      item_images: Table<ImageRow, Omit<ImageRow, 'state' | 'main_path' | 'thumb_path'>, never>;
    };
    Views: Empty;
    Functions: { commit_image: { Args: { p_image_id: string }; Returns: undefined } };
    Enums: Empty;
    CompositeTypes: Empty;
  };
};
