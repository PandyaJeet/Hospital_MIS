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
      beds: {
        Row: {
          bed_number: string
          created_at: string
          current_visit_id: string | null
          id: string
          notes: string | null
          status: string
          tenant_id: string
          updated_at: string
          ward_name: string
        }
        Insert: {
          bed_number: string
          created_at?: string
          current_visit_id?: string | null
          id?: string
          notes?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
          ward_name: string
        }
        Update: {
          bed_number?: string
          created_at?: string
          current_visit_id?: string | null
          id?: string
          notes?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
          ward_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "beds_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "beds_visit_same_tenant"
            columns: ["current_visit_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "rounds_overview"
            referencedColumns: ["visit_id", "tenant_id"]
          },
          {
            foreignKeyName: "beds_visit_same_tenant"
            columns: ["current_visit_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id", "tenant_id"]
          },
        ]
      }
      billing_line_items: {
        Row: {
          amount: number | null
          created_at: string
          created_by: string | null
          description: string
          hsn_sac_code: string | null
          id: string
          invoice_id: string | null
          is_auto: boolean
          patient_id: string
          quantity: number
          source_id: string | null
          source_type: string
          tax_amount: number | null
          tax_category: string
          tax_rate: number
          tenant_id: string
          unit_amount: number
          updated_at: string
          visit_id: string
        }
        Insert: {
          amount?: number | null
          created_at?: string
          created_by?: string | null
          description: string
          hsn_sac_code?: string | null
          id?: string
          invoice_id?: string | null
          is_auto?: boolean
          patient_id: string
          quantity?: number
          source_id?: string | null
          source_type: string
          tax_amount?: number | null
          tax_category?: string
          tax_rate?: number
          tenant_id: string
          unit_amount?: number
          updated_at?: string
          visit_id: string
        }
        Update: {
          amount?: number | null
          created_at?: string
          created_by?: string | null
          description?: string
          hsn_sac_code?: string | null
          id?: string
          invoice_id?: string | null
          is_auto?: boolean
          patient_id?: string
          quantity?: number
          source_id?: string | null
          source_type?: string
          tax_amount?: number | null
          tax_category?: string
          tax_rate?: number
          tenant_id?: string
          unit_amount?: number
          updated_at?: string
          visit_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_invoice_same_tenant"
            columns: ["invoice_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "billing_line_items_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_line_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_patient_same_tenant"
            columns: ["patient_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "billing_visit_same_tenant"
            columns: ["visit_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "rounds_overview"
            referencedColumns: ["visit_id", "tenant_id"]
          },
          {
            foreignKeyName: "billing_visit_same_tenant"
            columns: ["visit_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id", "tenant_id"]
          },
        ]
      }
      clinical_notes: {
        Row: {
          advice: string | null
          author_id: string
          chief_complaint: string | null
          created_at: string
          diagnosis: string | null
          examination: string | null
          follow_up_instructions: string | null
          history: string | null
          id: string
          note_text: string | null
          template_type: string | null
          tenant_id: string
          updated_at: string
          visit_id: string
        }
        Insert: {
          advice?: string | null
          author_id: string
          chief_complaint?: string | null
          created_at?: string
          diagnosis?: string | null
          examination?: string | null
          follow_up_instructions?: string | null
          history?: string | null
          id?: string
          note_text?: string | null
          template_type?: string | null
          tenant_id: string
          updated_at?: string
          visit_id: string
        }
        Update: {
          advice?: string | null
          author_id?: string
          chief_complaint?: string | null
          created_at?: string
          diagnosis?: string | null
          examination?: string | null
          follow_up_instructions?: string | null
          history?: string | null
          id?: string
          note_text?: string | null
          template_type?: string | null
          tenant_id?: string
          updated_at?: string
          visit_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "clinical_notes_author_same_tenant"
            columns: ["author_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "clinical_notes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clinical_notes_visit_same_tenant"
            columns: ["visit_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "rounds_overview"
            referencedColumns: ["visit_id", "tenant_id"]
          },
          {
            foreignKeyName: "clinical_notes_visit_same_tenant"
            columns: ["visit_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id", "tenant_id"]
          },
        ]
      }
      drug_interactions: {
        Row: {
          created_at: string
          description: string
          generic_a: string
          generic_b: string
          id: string
          severity: string
          source_note: string | null
        }
        Insert: {
          created_at?: string
          description: string
          generic_a: string
          generic_b: string
          id?: string
          severity: string
          source_note?: string | null
        }
        Update: {
          created_at?: string
          description?: string
          generic_a?: string
          generic_b?: string
          id?: string
          severity?: string
          source_note?: string | null
        }
        Relationships: []
      }
      drugs: {
        Row: {
          allergy_tags: string[]
          brand_name: string
          brand_name_normalized: string | null
          created_at: string
          drug_class: string | null
          form: string | null
          generic_name: string
          generic_name_normalized: string | null
          gst_rate: number | null
          id: string
          interaction_generics: string[]
          is_otc: boolean
          mrp: number | null
          notes: string | null
          strength: string | null
        }
        Insert: {
          allergy_tags?: string[]
          brand_name: string
          brand_name_normalized?: string | null
          created_at?: string
          drug_class?: string | null
          form?: string | null
          generic_name: string
          generic_name_normalized?: string | null
          gst_rate?: number | null
          id?: string
          interaction_generics?: string[]
          is_otc?: boolean
          mrp?: number | null
          notes?: string | null
          strength?: string | null
        }
        Update: {
          allergy_tags?: string[]
          brand_name?: string
          brand_name_normalized?: string | null
          created_at?: string
          drug_class?: string | null
          form?: string | null
          generic_name?: string
          generic_name_normalized?: string | null
          gst_rate?: number | null
          id?: string
          interaction_generics?: string[]
          is_otc?: boolean
          mrp?: number | null
          notes?: string | null
          strength?: string | null
        }
        Relationships: []
      }
      invites: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string
          role: string
          tenant_id: string
          token: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          email: string
          expires_at?: string
          id?: string
          invited_by?: string
          role: string
          tenant_id: string
          token?: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string
          role?: string
          tenant_id?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "invites_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_tax_lines: {
        Row: {
          created_at: string
          id: string
          invoice_id: string
          tax_amount: number
          tax_category: string
          tax_rate: number
          taxable_amount: number
          tenant_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          invoice_id: string
          tax_amount?: number
          tax_category: string
          tax_rate: number
          taxable_amount?: number
          tenant_id: string
        }
        Update: {
          created_at?: string
          id?: string
          invoice_id?: string
          tax_amount?: number
          tax_category?: string
          tax_rate?: number
          taxable_amount?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoice_tax_lines_invoice_same_tenant"
            columns: ["invoice_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id", "tenant_id"]
          },
        ]
      }
      invoices: {
        Row: {
          amount_paid: number
          created_at: string
          created_by: string | null
          grand_total: number | null
          gst_state_code_snapshot: string | null
          gstin_snapshot: string | null
          id: string
          invoice_number: number
          is_gst_invoice: boolean
          issued_at: string | null
          notes: string | null
          patient_id: string
          payment_mode: string | null
          status: string
          subtotal: number
          tax_total: number
          tenant_id: string
          updated_at: string
          visit_id: string
        }
        Insert: {
          amount_paid?: number
          created_at?: string
          created_by?: string | null
          grand_total?: number | null
          gst_state_code_snapshot?: string | null
          gstin_snapshot?: string | null
          id?: string
          invoice_number: number
          is_gst_invoice?: boolean
          issued_at?: string | null
          notes?: string | null
          patient_id: string
          payment_mode?: string | null
          status?: string
          subtotal?: number
          tax_total?: number
          tenant_id: string
          updated_at?: string
          visit_id: string
        }
        Update: {
          amount_paid?: number
          created_at?: string
          created_by?: string | null
          grand_total?: number | null
          gst_state_code_snapshot?: string | null
          gstin_snapshot?: string | null
          id?: string
          invoice_number?: number
          is_gst_invoice?: boolean
          issued_at?: string | null
          notes?: string | null
          patient_id?: string
          payment_mode?: string | null
          status?: string
          subtotal?: number
          tax_total?: number
          tenant_id?: string
          updated_at?: string
          visit_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoices_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_patient_same_tenant"
            columns: ["patient_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "invoices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_visit_same_tenant"
            columns: ["visit_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "rounds_overview"
            referencedColumns: ["visit_id", "tenant_id"]
          },
          {
            foreignKeyName: "invoices_visit_same_tenant"
            columns: ["visit_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id", "tenant_id"]
          },
        ]
      }
      lab_critical_ranges: {
        Row: {
          aliases: string[]
          created_at: string
          critical_high: number | null
          critical_low: number | null
          id: string
          normal_high: number | null
          normal_low: number | null
          source_note: string | null
          test_code: string
          test_name: string
          test_name_normalized: string | null
          unit: string
          unit_aliases: string[]
        }
        Insert: {
          aliases?: string[]
          created_at?: string
          critical_high?: number | null
          critical_low?: number | null
          id?: string
          normal_high?: number | null
          normal_low?: number | null
          source_note?: string | null
          test_code: string
          test_name: string
          test_name_normalized?: string | null
          unit: string
          unit_aliases?: string[]
        }
        Update: {
          aliases?: string[]
          created_at?: string
          critical_high?: number | null
          critical_low?: number | null
          id?: string
          normal_high?: number | null
          normal_low?: number | null
          source_note?: string | null
          test_code?: string
          test_name?: string
          test_name_normalized?: string | null
          unit?: string
          unit_aliases?: string[]
        }
        Relationships: []
      }
      lab_orders: {
        Row: {
          cancellation_reason: string | null
          created_at: string
          id: string
          notes: string | null
          ordered_at: string
          ordered_by: string
          patient_id: string
          priority: string
          status: string
          tenant_id: string
          test_name: string
          test_name_normalized: string | null
          updated_at: string
          visit_id: string
        }
        Insert: {
          cancellation_reason?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          ordered_at?: string
          ordered_by: string
          patient_id: string
          priority?: string
          status?: string
          tenant_id: string
          test_name: string
          test_name_normalized?: string | null
          updated_at?: string
          visit_id: string
        }
        Update: {
          cancellation_reason?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          ordered_at?: string
          ordered_by?: string
          patient_id?: string
          priority?: string
          status?: string
          tenant_id?: string
          test_name?: string
          test_name_normalized?: string | null
          updated_at?: string
          visit_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lab_orders_ordered_by_same_tenant"
            columns: ["ordered_by", "tenant_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "lab_orders_patient_same_tenant"
            columns: ["patient_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "lab_orders_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lab_orders_visit_same_tenant"
            columns: ["visit_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "rounds_overview"
            referencedColumns: ["visit_id", "tenant_id"]
          },
          {
            foreignKeyName: "lab_orders_visit_same_tenant"
            columns: ["visit_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id", "tenant_id"]
          },
        ]
      }
      lab_results: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          created_at: string
          critical_check_status: string
          critical_direction: string | null
          critical_high_used: number | null
          critical_low_used: number | null
          id: string
          is_critical: boolean
          lab_order_id: string
          notes: string | null
          reference_range: string | null
          reported_at: string
          reported_by: string
          requires_manual_review: boolean | null
          result_numeric: number | null
          result_value: string
          tenant_id: string
          unit: string | null
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          created_at?: string
          critical_check_status?: string
          critical_direction?: string | null
          critical_high_used?: number | null
          critical_low_used?: number | null
          id?: string
          is_critical?: boolean
          lab_order_id: string
          notes?: string | null
          reference_range?: string | null
          reported_at?: string
          reported_by: string
          requires_manual_review?: boolean | null
          result_numeric?: number | null
          result_value: string
          tenant_id: string
          unit?: string | null
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          created_at?: string
          critical_check_status?: string
          critical_direction?: string | null
          critical_high_used?: number | null
          critical_low_used?: number | null
          id?: string
          is_critical?: boolean
          lab_order_id?: string
          notes?: string | null
          reference_range?: string | null
          reported_at?: string
          reported_by?: string
          requires_manual_review?: boolean | null
          result_numeric?: number | null
          result_value?: string
          tenant_id?: string
          unit?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lab_results_ack_by_same_tenant"
            columns: ["acknowledged_by", "tenant_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "lab_results_order_same_tenant"
            columns: ["lab_order_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "lab_orders"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "lab_results_reported_by_same_tenant"
            columns: ["reported_by", "tenant_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "lab_results_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      medication_administrations: {
        Row: {
          administered_at: string
          administered_by: string
          created_at: string
          id: string
          notes: string | null
          prescription_item_id: string
          scan_basis: string
          status: string
          tenant_id: string
          visit_id: string
        }
        Insert: {
          administered_at?: string
          administered_by: string
          created_at?: string
          id?: string
          notes?: string | null
          prescription_item_id: string
          scan_basis: string
          status: string
          tenant_id: string
          visit_id: string
        }
        Update: {
          administered_at?: string
          administered_by?: string
          created_at?: string
          id?: string
          notes?: string | null
          prescription_item_id?: string
          scan_basis?: string
          status?: string
          tenant_id?: string
          visit_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "medication_administrations_by_same_tenant"
            columns: ["administered_by", "tenant_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "medication_administrations_item_same_tenant"
            columns: ["prescription_item_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "prescription_items"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "medication_administrations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medication_administrations_visit_same_tenant"
            columns: ["visit_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "rounds_overview"
            referencedColumns: ["visit_id", "tenant_id"]
          },
          {
            foreignKeyName: "medication_administrations_visit_same_tenant"
            columns: ["visit_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id", "tenant_id"]
          },
        ]
      }
      patients: {
        Row: {
          address: string | null
          age_years: number | null
          allergies: string | null
          created_at: string
          dob: string | null
          full_name: string
          gender: string | null
          id: string
          patient_number: number
          phone: string | null
          phone_normalized: string | null
          registered_by: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          address?: string | null
          age_years?: number | null
          allergies?: string | null
          created_at?: string
          dob?: string | null
          full_name: string
          gender?: string | null
          id?: string
          patient_number: number
          phone?: string | null
          phone_normalized?: string | null
          registered_by?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          address?: string | null
          age_years?: number | null
          allergies?: string | null
          created_at?: string
          dob?: string | null
          full_name?: string
          gender?: string | null
          id?: string
          patient_number?: number
          phone?: string | null
          phone_normalized?: string | null
          registered_by?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "patients_registered_by_fkey"
            columns: ["registered_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patients_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      prescription_items: {
        Row: {
          created_at: string
          dose: string | null
          drug_id: string | null
          drug_name: string
          duration: string | null
          frequency: string | null
          generic_name: string | null
          id: string
          instructions: string | null
          is_generic: boolean
          prescription_id: string
          quantity: number | null
          tenant_id: string
          unit_price: number | null
        }
        Insert: {
          created_at?: string
          dose?: string | null
          drug_id?: string | null
          drug_name: string
          duration?: string | null
          frequency?: string | null
          generic_name?: string | null
          id?: string
          instructions?: string | null
          is_generic?: boolean
          prescription_id: string
          quantity?: number | null
          tenant_id: string
          unit_price?: number | null
        }
        Update: {
          created_at?: string
          dose?: string | null
          drug_id?: string | null
          drug_name?: string
          duration?: string | null
          frequency?: string | null
          generic_name?: string | null
          id?: string
          instructions?: string | null
          is_generic?: boolean
          prescription_id?: string
          quantity?: number | null
          tenant_id?: string
          unit_price?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "prescription_items_drug_id_fkey"
            columns: ["drug_id"]
            isOneToOne: false
            referencedRelation: "drugs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prescription_items_parent_same_tenant"
            columns: ["prescription_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "prescriptions"
            referencedColumns: ["id", "tenant_id"]
          },
        ]
      }
      prescriptions: {
        Row: {
          created_at: string
          doctor_id: string
          id: string
          issued_at: string | null
          notes: string | null
          status: string
          tenant_id: string
          updated_at: string
          visit_id: string
        }
        Insert: {
          created_at?: string
          doctor_id: string
          id?: string
          issued_at?: string | null
          notes?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
          visit_id: string
        }
        Update: {
          created_at?: string
          doctor_id?: string
          id?: string
          issued_at?: string | null
          notes?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
          visit_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "prescriptions_doctor_same_tenant"
            columns: ["doctor_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "prescriptions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prescriptions_visit_same_tenant"
            columns: ["visit_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "rounds_overview"
            referencedColumns: ["visit_id", "tenant_id"]
          },
          {
            foreignKeyName: "prescriptions_visit_same_tenant"
            columns: ["visit_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id", "tenant_id"]
          },
        ]
      }
      profiles: {
        Row: {
          consultation_fee: number | null
          created_at: string
          full_name: string | null
          id: string
          role: string
          tenant_id: string | null
        }
        Insert: {
          consultation_fee?: number | null
          created_at?: string
          full_name?: string | null
          id: string
          role?: string
          tenant_id?: string | null
        }
        Update: {
          consultation_fee?: number | null
          created_at?: string
          full_name?: string | null
          id?: string
          role?: string
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          assigned_to: string | null
          cancellation_reason: string | null
          completed_at: string | null
          completed_by: string | null
          created_at: string
          created_by: string | null
          due_at: string
          id: string
          is_auto: boolean
          notes: string | null
          source_id: string | null
          source_type: string | null
          status: string
          task_type: string
          tenant_id: string
          title: string | null
          updated_at: string
          visit_id: string
        }
        Insert: {
          assigned_to?: string | null
          cancellation_reason?: string | null
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by?: string | null
          due_at?: string
          id?: string
          is_auto?: boolean
          notes?: string | null
          source_id?: string | null
          source_type?: string | null
          status?: string
          task_type: string
          tenant_id: string
          title?: string | null
          updated_at?: string
          visit_id: string
        }
        Update: {
          assigned_to?: string | null
          cancellation_reason?: string | null
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by?: string | null
          due_at?: string
          id?: string
          is_auto?: boolean
          notes?: string | null
          source_id?: string | null
          source_type?: string | null
          status?: string
          task_type?: string
          tenant_id?: string
          title?: string | null
          updated_at?: string
          visit_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_assigned_to_same_tenant"
            columns: ["assigned_to", "tenant_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "tasks_completed_by_same_tenant"
            columns: ["completed_by", "tenant_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "tasks_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_visit_same_tenant"
            columns: ["visit_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "rounds_overview"
            referencedColumns: ["visit_id", "tenant_id"]
          },
          {
            foreignKeyName: "tasks_visit_same_tenant"
            columns: ["visit_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id", "tenant_id"]
          },
        ]
      }
      tenants: {
        Row: {
          address: string | null
          created_at: string
          default_consultation_fee: number
          gst_registered: boolean
          gst_state_code: string | null
          gstin: string | null
          id: string
          name: string
          phone: string | null
          tier: number
        }
        Insert: {
          address?: string | null
          created_at?: string
          default_consultation_fee?: number
          gst_registered?: boolean
          gst_state_code?: string | null
          gstin?: string | null
          id?: string
          name: string
          phone?: string | null
          tier?: number
        }
        Update: {
          address?: string | null
          created_at?: string
          default_consultation_fee?: number
          gst_registered?: boolean
          gst_state_code?: string | null
          gstin?: string | null
          id?: string
          name?: string
          phone?: string | null
          tier?: number
        }
        Relationships: []
      }
      visits: {
        Row: {
          admitted_at: string | null
          bed_id: string | null
          cancellation_reason: string | null
          care_setting: string
          checked_in_at: string
          consultation_ended_at: string | null
          consultation_started_at: string | null
          created_at: string
          created_by: string | null
          discharged_at: string | null
          doctor_id: string | null
          id: string
          last_vitals_at: string | null
          patient_id: string
          queue_number: number
          status: string
          tenant_id: string
          updated_at: string
          visit_date: string
          visit_type: string
        }
        Insert: {
          admitted_at?: string | null
          bed_id?: string | null
          cancellation_reason?: string | null
          care_setting?: string
          checked_in_at?: string
          consultation_ended_at?: string | null
          consultation_started_at?: string | null
          created_at?: string
          created_by?: string | null
          discharged_at?: string | null
          doctor_id?: string | null
          id?: string
          last_vitals_at?: string | null
          patient_id: string
          queue_number: number
          status?: string
          tenant_id: string
          updated_at?: string
          visit_date?: string
          visit_type?: string
        }
        Update: {
          admitted_at?: string | null
          bed_id?: string | null
          cancellation_reason?: string | null
          care_setting?: string
          checked_in_at?: string
          consultation_ended_at?: string | null
          consultation_started_at?: string | null
          created_at?: string
          created_by?: string | null
          discharged_at?: string | null
          doctor_id?: string | null
          id?: string
          last_vitals_at?: string | null
          patient_id?: string
          queue_number?: number
          status?: string
          tenant_id?: string
          updated_at?: string
          visit_date?: string
          visit_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "visits_bed_same_tenant"
            columns: ["bed_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "beds"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "visits_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "visits_doctor_same_tenant"
            columns: ["doctor_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "visits_patient_same_tenant"
            columns: ["patient_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "visits_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      vitals: {
        Row: {
          blood_glucose: number | null
          bp_diastolic: number | null
          bp_systolic: number | null
          created_at: string
          id: string
          notes: string | null
          pulse_bpm: number | null
          recorded_at: string
          recorded_by: string
          respiratory_rate: number | null
          spo2_percent: number | null
          temperature_c: number | null
          tenant_id: string
          updated_at: string
          visit_id: string
        }
        Insert: {
          blood_glucose?: number | null
          bp_diastolic?: number | null
          bp_systolic?: number | null
          created_at?: string
          id?: string
          notes?: string | null
          pulse_bpm?: number | null
          recorded_at?: string
          recorded_by: string
          respiratory_rate?: number | null
          spo2_percent?: number | null
          temperature_c?: number | null
          tenant_id: string
          updated_at?: string
          visit_id: string
        }
        Update: {
          blood_glucose?: number | null
          bp_diastolic?: number | null
          bp_systolic?: number | null
          created_at?: string
          id?: string
          notes?: string | null
          pulse_bpm?: number | null
          recorded_at?: string
          recorded_by?: string
          respiratory_rate?: number | null
          spo2_percent?: number | null
          temperature_c?: number | null
          tenant_id?: string
          updated_at?: string
          visit_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vitals_recorded_by_same_tenant"
            columns: ["recorded_by", "tenant_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "vitals_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vitals_visit_same_tenant"
            columns: ["visit_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "rounds_overview"
            referencedColumns: ["visit_id", "tenant_id"]
          },
          {
            foreignKeyName: "vitals_visit_same_tenant"
            columns: ["visit_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id", "tenant_id"]
          },
        ]
      }
    }
    Views: {
      critical_lab_alerts: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          bed_number: string | null
          care_setting: string | null
          critical_check_status: string | null
          critical_direction: string | null
          critical_high_used: number | null
          critical_low_used: number | null
          is_critical: boolean | null
          lab_order_id: string | null
          lab_result_id: string | null
          ordered_at: string | null
          ordered_by: string | null
          patient_id: string | null
          patient_number: number | null
          priority: string | null
          reported_at: string | null
          reported_by: string | null
          requires_manual_review: boolean | null
          result_numeric: number | null
          result_value: string | null
          tenant_id: string | null
          test_name: string | null
          unit: string | null
          visit_id: string | null
          ward_name: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lab_results_ack_by_same_tenant"
            columns: ["acknowledged_by", "tenant_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "lab_results_order_same_tenant"
            columns: ["lab_order_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "lab_orders"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "lab_results_reported_by_same_tenant"
            columns: ["reported_by", "tenant_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "lab_results_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      rounds_overview: {
        Row: {
          admitted_at: string | null
          age_years: number | null
          allergies: string | null
          bed_id: string | null
          bed_number: string | null
          blood_glucose: number | null
          bp_diastolic: number | null
          bp_systolic: number | null
          care_setting: string | null
          checked_in_at: string | null
          discharged_at: string | null
          dob: string | null
          doctor_id: string | null
          gender: string | null
          last_vitals_at: string | null
          overdue_tasks: number | null
          patient_id: string | null
          patient_name: string | null
          patient_number: number | null
          pending_tasks: number | null
          pulse_bpm: number | null
          queue_number: number | null
          respiratory_rate: number | null
          spo2_percent: number | null
          temperature_c: number | null
          tenant_id: string | null
          unacknowledged_alerts: number | null
          visit_date: string | null
          visit_id: string | null
          visit_status: string | null
          visit_type: string | null
          vitals_age_seconds: number | null
          vitals_recorded_at: string | null
          vitals_recorded_by: string | null
          ward_name: string | null
        }
        Relationships: [
          {
            foreignKeyName: "visits_bed_same_tenant"
            columns: ["bed_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "beds"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "visits_doctor_same_tenant"
            columns: ["doctor_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "visits_patient_same_tenant"
            columns: ["patient_id", "tenant_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id", "tenant_id"]
          },
          {
            foreignKeyName: "visits_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      accept_invite: { Args: { p_token: string }; Returns: Json }
      acknowledge_critical_result: {
        Args: { p_lab_result_id: string; p_note?: string }
        Returns: Json
      }
      admin_set_user_role: {
        Args: { p_role: string; p_user_id: string }
        Returns: Json
      }
      admit_patient_to_bed: {
        Args: { p_bed_id: string; p_visit_id: string }
        Returns: Json
      }
      cancel_task: {
        Args: { p_reason?: string; p_task_id: string }
        Returns: Json
      }
      check_in_patient: {
        Args: {
          p_doctor_id?: string
          p_patient_id: string
          p_visit_type?: string
        }
        Returns: Json
      }
      check_prescription_safety: {
        Args: { p_drug_names: string[]; p_patient_id: string }
        Returns: Json
      }
      close_lab_sample_task: {
        Args: {
          p_by: string
          p_lab_order_id: string
          p_outcome: string
          p_tenant_id: string
        }
        Returns: number
      }
      complete_task: {
        Args: { p_notes?: string; p_task_id: string }
        Returns: Json
      }
      create_invite: {
        Args: { p_email: string; p_expires_in_hours?: number; p_role: string }
        Returns: Json
      }
      create_invoice_for_visit: { Args: { p_visit_id: string }; Returns: Json }
      create_tenant_and_assign_admin: {
        Args: { p_tenant_name: string }
        Returns: Json
      }
      current_tenant_id: { Args: never; Returns: string }
      current_tenant_tier: { Args: never; Returns: number }
      current_user_role: { Args: never; Returns: string }
      discharge_patient: {
        Args: { p_notes?: string; p_visit_id: string }
        Returns: Json
      }
      evaluate_lab_critical: {
        Args: { p_test_name: string; p_unit?: string; p_value: string }
        Returns: Json
      }
      get_critical_lab_alert_payload: {
        Args: { p_lab_result_id: string }
        Returns: Json
      }
      get_invoice_for_pdf: { Args: { p_invoice_id: string }; Returns: Json }
      get_prescription_for_pdf: {
        Args: { p_prescription_id: string }
        Returns: Json
      }
      has_tenant_role: { Args: { p_roles: string[] }; Returns: boolean }
      is_tenant_admin: { Args: never; Returns: boolean }
      is_tenant_staff: { Args: never; Returns: boolean }
      issue_prescription: { Args: { p_prescription_id: string }; Returns: Json }
      record_lab_result: {
        Args: {
          p_lab_order_id: string
          p_notes?: string
          p_reference_range?: string
          p_result_value: string
          p_unit?: string
        }
        Returns: Json
      }
      record_medication_administration: {
        Args: {
          p_allow_repeat?: boolean
          p_notes?: string
          p_prescription_item_id: string
          p_scanned_patient_code: string
          p_status?: string
        }
        Returns: Json
      }
      register_patient: {
        Args: {
          p_address?: string
          p_age_years?: number
          p_allergies?: string
          p_allow_duplicate_phone?: boolean
          p_dob?: string
          p_full_name: string
          p_gender?: string
          p_phone?: string
        }
        Returns: Json
      }
      resolve_tax_treatment: {
        Args: {
          p_drug_gst_rate?: number
          p_is_medicine: boolean
          p_tenant_id: string
        }
        Returns: {
          tax_category: string
          tax_rate: number
        }[]
      }
      set_bed_status: {
        Args: { p_bed_id: string; p_status: string }
        Returns: Json
      }
      set_lab_order_status: {
        Args: { p_lab_order_id: string; p_reason?: string; p_status: string }
        Returns: Json
      }
      set_visit_status: {
        Args: {
          p_cancellation_reason?: string
          p_status: string
          p_visit_id: string
        }
        Returns: Json
      }
      tenant_has_tier: { Args: { p_min_tier: number }; Returns: boolean }
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
