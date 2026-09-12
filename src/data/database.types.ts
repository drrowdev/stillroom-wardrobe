export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      combination_rules: {
        Row: {
          created_at: string
          id: string
          item_high: string
          item_low: string
          owner_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          item_high: string
          item_low: string
          owner_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          item_high?: string
          item_low?: string
          owner_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "combination_rules_owner_id_item_high_fkey"
            columns: ["owner_id", "item_high"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["owner_id", "id"]
          },
          {
            foreignKeyName: "combination_rules_owner_id_item_low_fkey"
            columns: ["owner_id", "item_low"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["owner_id", "id"]
          },
        ]
      }
      item_images: {
        Row: {
          alt_text: string
          created_at: string
          description_version: number
          height: number
          id: string
          item_id: string
          main_bytes: number
          main_path: string | null
          main_sha256: string
          owner_id: string
          retired_at: string | null
          state: string
          thumb_bytes: number
          thumb_path: string | null
          thumb_sha256: string
          width: number
        }
        Insert: {
          alt_text: string
          created_at?: string
          description_version?: number
          height: number
          id?: string
          item_id: string
          main_bytes: number
          main_path?: string | null
          main_sha256: string
          owner_id?: string
          retired_at?: string | null
          state?: string
          thumb_bytes: number
          thumb_path?: string | null
          thumb_sha256: string
          width: number
        }
        Update: {
          alt_text?: string
          created_at?: string
          description_version?: number
          height?: number
          id?: string
          item_id?: string
          main_bytes?: number
          main_path?: string | null
          main_sha256?: string
          owner_id?: string
          retired_at?: string | null
          state?: string
          thumb_bytes?: number
          thumb_path?: string | null
          thumb_sha256?: string
          width?: number
        }
        Relationships: [
          {
            foreignKeyName: "item_images_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "item_images_owner_id_item_id_fkey"
            columns: ["owner_id", "item_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["owner_id", "id"]
          },
        ]
      }
      items: {
        Row: {
          availability: string
          brand: string | null
          category: string
          colours: string[]
          created_at: string
          currency: string
          deleted_at: string | null
          exclude_suggestions: boolean
          favourite: boolean
          field_provenance: Json
          formality: number | null
          garment_length: string | null
          id: string
          lifecycle: string
          lower_coverage: number | null
          material: string | null
          max_temp: number | null
          min_temp: number | null
          notes: string
          owner_id: string
          pattern: string | null
          purchase_date: string | null
          purchase_price: number | null
          rain_rating: number | null
          seasons: string[]
          size_label: string | null
          sleeve_length: string | null
          style_tags: string[]
          subcategory: string | null
          tags: string[]
          title: string
          updated_at: string
          upper_coverage: number | null
          version: number
          warmth: number | null
          wear_more: boolean
          windproof: boolean | null
        }
        Insert: {
          availability?: string
          brand?: string | null
          category: string
          colours?: string[]
          created_at?: string
          currency?: string
          deleted_at?: string | null
          exclude_suggestions?: boolean
          favourite?: boolean
          field_provenance?: Json
          formality?: number | null
          garment_length?: string | null
          id?: string
          lifecycle?: string
          lower_coverage?: number | null
          material?: string | null
          max_temp?: number | null
          min_temp?: number | null
          notes?: string
          owner_id?: string
          pattern?: string | null
          purchase_date?: string | null
          purchase_price?: number | null
          rain_rating?: number | null
          seasons?: string[]
          size_label?: string | null
          sleeve_length?: string | null
          style_tags?: string[]
          subcategory?: string | null
          tags?: string[]
          title: string
          updated_at?: string
          upper_coverage?: number | null
          version?: number
          warmth?: number | null
          wear_more?: boolean
          windproof?: boolean | null
        }
        Update: {
          availability?: string
          brand?: string | null
          category?: string
          colours?: string[]
          created_at?: string
          currency?: string
          deleted_at?: string | null
          exclude_suggestions?: boolean
          favourite?: boolean
          field_provenance?: Json
          formality?: number | null
          garment_length?: string | null
          id?: string
          lifecycle?: string
          lower_coverage?: number | null
          material?: string | null
          max_temp?: number | null
          min_temp?: number | null
          notes?: string
          owner_id?: string
          pattern?: string | null
          purchase_date?: string | null
          purchase_price?: number | null
          rain_rating?: number | null
          seasons?: string[]
          size_label?: string | null
          sleeve_length?: string | null
          style_tags?: string[]
          subcategory?: string | null
          tags?: string[]
          title?: string
          updated_at?: string
          upper_coverage?: number | null
          version?: number
          warmth?: number | null
          wear_more?: boolean
          windproof?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "items_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["owner_id"]
          },
        ]
      }
      outfit_items: {
        Row: {
          item_id: string
          outfit_id: string
          owner_id: string
          position: number
        }
        Insert: {
          item_id: string
          outfit_id: string
          owner_id?: string
          position: number
        }
        Update: {
          item_id?: string
          outfit_id?: string
          owner_id?: string
          position?: number
        }
        Relationships: [
          {
            foreignKeyName: "outfit_items_owner_id_item_id_fkey"
            columns: ["owner_id", "item_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["owner_id", "id"]
          },
          {
            foreignKeyName: "outfit_items_owner_id_outfit_id_fkey"
            columns: ["owner_id", "outfit_id"]
            isOneToOne: false
            referencedRelation: "outfits"
            referencedColumns: ["owner_id", "id"]
          },
        ]
      }
      outfits: {
        Row: {
          created_at: string
          deleted_at: string | null
          favourite: boolean
          id: string
          notes: string
          occasion: string
          owner_id: string
          title: string
          updated_at: string
          version: number
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          favourite?: boolean
          id?: string
          notes?: string
          occasion?: string
          owner_id?: string
          title: string
          updated_at?: string
          version?: number
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          favourite?: boolean
          id?: string
          notes?: string
          occasion?: string
          owner_id?: string
          title?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "outfits_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["owner_id"]
          },
        ]
      }
      profiles: {
        Row: {
          ai_consented_at: string | null
          ai_enabled: boolean
          ai_notice_revision: number | null
          created_at: string
          currency: string
          display_name: string
          latitude: number | null
          longitude: number | null
          owner_id: string
          timezone: string
          ui_language: string | null
          updated_at: string
          version: number
          weather_city: string | null
          weather_enabled: boolean
        }
        Insert: {
          ai_consented_at?: string | null
          ai_enabled?: boolean
          ai_notice_revision?: number | null
          created_at?: string
          currency?: string
          display_name: string
          latitude?: number | null
          longitude?: number | null
          owner_id?: string
          timezone?: string
          ui_language?: string | null
          updated_at?: string
          version?: number
          weather_city?: string | null
          weather_enabled?: boolean
        }
        Update: {
          ai_consented_at?: string | null
          ai_enabled?: boolean
          ai_notice_revision?: number | null
          created_at?: string
          currency?: string
          display_name?: string
          latitude?: number | null
          longitude?: number | null
          owner_id?: string
          timezone?: string
          ui_language?: string | null
          updated_at?: string
          version?: number
          weather_city?: string | null
          weather_enabled?: boolean
        }
        Relationships: []
      }
      style_preferences: {
        Row: {
          cold_sensitivity: number
          created_at: string
          excluded_categories: string[]
          minimum_lower_coverage: number
          minimum_upper_coverage: number
          owner_id: string
          preferred_colours: string[]
          repeat_gap_days: number
          style_tags: string[]
          updated_at: string
          version: number
        }
        Insert: {
          cold_sensitivity?: number
          created_at?: string
          excluded_categories?: string[]
          minimum_lower_coverage?: number
          minimum_upper_coverage?: number
          owner_id?: string
          preferred_colours?: string[]
          repeat_gap_days?: number
          style_tags?: string[]
          updated_at?: string
          version?: number
        }
        Update: {
          cold_sensitivity?: number
          created_at?: string
          excluded_categories?: string[]
          minimum_lower_coverage?: number
          minimum_upper_coverage?: number
          owner_id?: string
          preferred_colours?: string[]
          repeat_gap_days?: number
          style_tags?: string[]
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "style_preferences_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["owner_id"]
          },
        ]
      }
      suggestion_feedback: {
        Row: {
          created_at: string
          id: string
          item_ids: string[]
          owner_id: string
          signature: string
          vote: number
        }
        Insert: {
          created_at?: string
          id?: string
          item_ids: string[]
          owner_id?: string
          signature?: string
          vote: number
        }
        Update: {
          created_at?: string
          id?: string
          item_ids?: string[]
          owner_id?: string
          signature?: string
          vote?: number
        }
        Relationships: [
          {
            foreignKeyName: "suggestion_feedback_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["owner_id"]
          },
        ]
      }
      wear_event_items: {
        Row: {
          category_snapshot: string
          event_id: string
          id: string
          import_id: string | null
          item_id: string | null
          owner_id: string
          title_snapshot: string
        }
        Insert: {
          category_snapshot: string
          event_id: string
          id?: string
          import_id?: string | null
          item_id?: string | null
          owner_id?: string
          title_snapshot: string
        }
        Update: {
          category_snapshot?: string
          event_id?: string
          id?: string
          import_id?: string | null
          item_id?: string | null
          owner_id?: string
          title_snapshot?: string
        }
        Relationships: [
          {
            foreignKeyName: "wear_event_items_owner_id_event_id_fkey"
            columns: ["owner_id", "event_id"]
            isOneToOne: false
            referencedRelation: "wear_events"
            referencedColumns: ["owner_id", "id"]
          },
          {
            foreignKeyName: "wear_event_items_owner_id_item_id_fkey"
            columns: ["owner_id", "item_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["owner_id", "id"]
          },
        ]
      }
      wear_events: {
        Row: {
          created_at: string
          deleted_at: string | null
          id: string
          label: string
          local_date: string
          outfit_id: string | null
          owner_id: string
          state: string
          timezone: string
          updated_at: string
          version: number
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          label?: string
          local_date: string
          outfit_id?: string | null
          owner_id?: string
          state?: string
          timezone?: string
          updated_at?: string
          version?: number
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          label?: string
          local_date?: string
          outfit_id?: string | null
          owner_id?: string
          state?: string
          timezone?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "wear_events_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["owner_id"]
          },
          {
            foreignKeyName: "wear_events_owner_id_outfit_id_fkey"
            columns: ["owner_id", "outfit_id"]
            isOneToOne: false
            referencedRelation: "outfits"
            referencedColumns: ["owner_id", "id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      ai_analysis_status: { Args: { p_request_id: string }; Returns: Json }
      ai_begin_request: {
        Args: {
          p_draft_id: string
          p_generation: number
          p_image_sha256: string
          p_request_id: string
        }
        Returns: Json
      }
      ai_claim_analysis: {
        Args: {
          p_byte_count: number
          p_draft_id: string
          p_generation: number
          p_height: number
          p_image_sha256: string
          p_manifest_id: string
          p_owner_id: string
          p_request_id: string
          p_width: number
        }
        Returns: Json
      }
      ai_finish_analysis: {
        Args: {
          p_code: string
          p_facts: Json
          p_manifest_id: string
          p_owner_id: string
          p_request_id: string
          p_usage: Json
        }
        Returns: Json
      }
      ai_mark_dispatched: {
        Args: { p_owner_id: string; p_request_id: string }
        Returns: Json
      }
      ai_purge_expired: { Args: { p_limit: number }; Returns: Json }
      ai_request_control: {
        Args: { p_action: string; p_request_id: string }
        Returns: Json
      }
      ai_set_consent: {
        Args: {
          p_enabled: boolean
          p_expected_version: number
          p_notice_revision: number
        }
        Returns: Json
      }
      ai_settle_request: {
        Args: {
          p_billed_micro: number
          p_code: string
          p_facts: Json
          p_owner_id: string
          p_request_id: string
        }
        Returns: Json
      }
      ai_status: { Args: never; Returns: Json }
      analyzed_item_save_preflight: {
        Args: { p_fingerprint: string; p_image_id: string; p_item_id: string }
        Returns: Json
      }
      cancel_analyzed_item_save: {
        Args: { p_fingerprint: string; p_image_id: string; p_item_id: string }
        Returns: undefined
      }
      commit_image: { Args: { p_image_id: string }; Returns: undefined }
      complete_analyzed_item_save: {
        Args: {
          p_fingerprint: string
          p_image_id: string
          p_item_id: string
          p_objects: Json
          p_owner_id: string
        }
        Returns: undefined
      }
      deletion_control: {
        Args: { p_action: string; p_code?: string; p_owner_id: string }
        Returns: Json
      }
      export_manifest: { Args: { p_export_id: string }; Returns: Json }
      finalize_item_save: {
        Args: { p_fingerprint: string; p_image_id: string; p_item_id: string }
        Returns: undefined
      }
      forget_image: { Args: { p_image_id: string }; Returns: undefined }
      item_attribution_history: { Args: { p_item_id: string }; Returns: Json }
      reserve_analyzed_item_save: {
        Args: { p_claim: Json; p_image: Json; p_item: Json }
        Returns: {
          fingerprint: string
          image: Json
          item: Json
          state: string
        }[]
      }
      reserve_item_save: {
        Args: { p_image: Json; p_item: Json }
        Returns: {
          fingerprint: string
          image: Json
          item: Json
          state: string
        }[]
      }
      restore_history_entry: {
        Args: {
          p_category: string
          p_event_id: string
          p_id: string
          p_import_id: string
          p_item_id: string
          p_title: string
        }
        Returns: undefined
      }
      retire_image: { Args: { p_image_id: string }; Returns: undefined }
      save_outfit: {
        Args: {
          p_expected_version?: number
          p_favourite: boolean
          p_id: string
          p_item_ids: string[]
          p_notes: string
          p_occasion: string
          p_title: string
        }
        Returns: number
      }
      save_wear_event: {
        Args: {
          p_expected_version?: number
          p_id: string
          p_item_ids: string[]
          p_label: string
          p_local_date: string
          p_outfit_id: string
          p_state: string
          p_timezone: string
        }
        Returns: number
      }
      update_image_description: {
        Args: {
          p_alt_text: string
          p_expected_description_version: number
          p_image_id: string
        }
        Returns: {
          alt_text: string
          description_version: number
          id: string
          item_id: string
          owner_id: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

