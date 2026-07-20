export type ApplicationStatus = 'pending' | 'approved' | 'rejected' | 'info_requested'

export interface VendorApplication {
  id: string
  created_at: string
  updated_at: string

  // Business Info
  business_name: string
  business_description: string | null
  product_categories: string[]
  website: string | null
  instagram: string | null
  facebook: string | null

  // Contact Info
  contact_name: string
  email: string
  phone: string

  // Booth Preference
  preferred_booth_tier: string | null
  special_requirements: string | null

  // Application Status
  status: ApplicationStatus
  admin_notes: string | null
  reviewed_at: string | null

  // Audit + smart-queue fields (migration v9)
  reviewed_by?: string | null
  dup_marker?: string | null
  completeness_score?: number | null
  documents?: VendorApplicationDocument[] | null

  // Payment + contract first-class columns. Source of truth for the "paid" /
  // "contract_signed" triage buckets (and the whatsapp-broadcast audience).
  // payment_status / paid_at written by the Yoco webhook + admin mark-paid
  // (confirm.ts, which also stamps paid_at on a fee waiver); contract_signed_at
  // stamped by the /exhibitor/contract/sign route. Legacy/portal payment state
  // also lives in the ⟦PORTAL:..⟧ marker on admin_notes (parsePortalState).
  payment_status?: string | null
  paid_at?: string | null
  contract_signed_at?: string | null
}

export interface VendorApplicationDocument {
  url: string
  name?: string
  kind?: string
  uploaded_at?: string
}

export interface WaMessage {
  id: string
  created_at: string
  direction: 'inbound' | 'outbound'
  phone: string
  application_id: string | null
  template_key: string | null
  body: string | null
  status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped'
  provider_message_id: string | null
  error: string | null
  metadata: Record<string, unknown> | null
}

export type AdminRole = 'owner' | 'operator' | 'viewer'

export interface AdminUser {
  id: string
  email: string
  name: string
  role: AdminRole
  created_at: string
}

export interface Database {
  public: {
    Tables: {
      vendor_applications: {
        Row: VendorApplication
        Insert: Omit<VendorApplication, 'id' | 'created_at' | 'updated_at' | 'status' | 'reviewed_at'>
        Update: Partial<VendorApplication>
      }
      admin_users: {
        Row: AdminUser
        Insert: Omit<AdminUser, 'created_at'>
        Update: Partial<AdminUser>
      }
    }
  }
}
