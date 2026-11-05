
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "assinaturas": {
                  Row: {
                    "comentario": string | null,"conteudo_assinado": NonNullable<Json>,"created_at": string,"decisao": Database["public"]['Enums']["decisao_aprovacao"],"etapa": Database["public"]['Enums']["etapa_aprovacao"],"hash_integridade": string,"id": string,"ip": string | null,"lote_id": string | null,"pagamento_id": string,"pagamento_versao": number,"user_agent": string | null,"user_id": string,"user_nome": string
                  }
                  ComputedFields: never
                  Insert: {
                    "comentario"?: string | null,"conteudo_assinado": NonNullable<Json>,"created_at"?: string,"decisao": Database["public"]['Enums']["decisao_aprovacao"],"etapa": Database["public"]['Enums']["etapa_aprovacao"],"hash_integridade": string,"id"?: string,"ip"?: string | null,"lote_id"?: string | null,"pagamento_id": string,"pagamento_versao": number,"user_agent"?: string | null,"user_id": string,"user_nome": string
                  }
                  Update: {
                    "comentario"?: string | null,"conteudo_assinado"?: NonNullable<Json>,"created_at"?: string,"decisao"?: Database["public"]['Enums']["decisao_aprovacao"],"etapa"?: Database["public"]['Enums']["etapa_aprovacao"],"hash_integridade"?: string,"id"?: string,"ip"?: string | null,"lote_id"?: string | null,"pagamento_id"?: string,"pagamento_versao"?: number,"user_agent"?: string | null,"user_id"?: string,"user_nome"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "assinaturas_pagamento_id_fkey"
      columns: ["pagamento_id"]
isOneToOne: false
      referencedRelation: "pagamentos"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "assinaturas_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"auditoria": {
                  Row: {
                    "acao": string,"created_at": string,"dados_antes": Json | null,"dados_depois": Json | null,"descricao": string | null,"entidade": string,"entidade_id": string | null,"id": number,"obra_id": string | null,"pagamento_id": string | null,"user_id": string | null,"user_nome": string | null,"user_perfil": Database["public"]['Enums']["perfil_usuario"] | null
                  }
                  ComputedFields: never
                  Insert: {
                    "acao": string,"created_at"?: string,"dados_antes"?: Json | null,"dados_depois"?: Json | null,"descricao"?: string | null,"entidade": string,"entidade_id"?: string | null,"id"?: never,"obra_id"?: string | null,"pagamento_id"?: string | null,"user_id"?: string | null,"user_nome"?: string | null,"user_perfil"?: Database["public"]['Enums']["perfil_usuario"] | null
                  }
                  Update: {
                    "acao"?: string,"created_at"?: string,"dados_antes"?: Json | null,"dados_depois"?: Json | null,"descricao"?: string | null,"entidade"?: string,"entidade_id"?: string | null,"id"?: never,"obra_id"?: string | null,"pagamento_id"?: string | null,"user_id"?: string | null,"user_nome"?: string | null,"user_perfil"?: Database["public"]['Enums']["perfil_usuario"] | null
                  }
                  Relationships: [
                    
                  ]
                },"documentos": {
                  Row: {
                    "ativo": boolean,"created_at": string,"documento_original_id": string | null,"enviado_por": string,"id": string,"mime_type": string | null,"motivo_substituicao": string | null,"nome_arquivo": string,"obra_id": string,"pagamento_id": string,"pagamento_versao": number,"sha256": string,"storage_path": string,"substituido_em": string | null,"substituido_por": string | null,"tamanho": number | null,"tipo": Database["public"]['Enums']["tipo_documento"],"versao": number
                  }
                  ComputedFields: never
                  Insert: {
                    "ativo"?: boolean,"created_at"?: string,"documento_original_id"?: string | null,"enviado_por": string,"id"?: string,"mime_type"?: string | null,"motivo_substituicao"?: string | null,"nome_arquivo": string,"obra_id": string,"pagamento_id": string,"pagamento_versao": number,"sha256": string,"storage_path": string,"substituido_em"?: string | null,"substituido_por"?: string | null,"tamanho"?: number | null,"tipo": Database["public"]['Enums']["tipo_documento"],"versao"?: number
                  }
                  Update: {
                    "ativo"?: boolean,"created_at"?: string,"documento_original_id"?: string | null,"enviado_por"?: string,"id"?: string,"mime_type"?: string | null,"motivo_substituicao"?: string | null,"nome_arquivo"?: string,"obra_id"?: string,"pagamento_id"?: string,"pagamento_versao"?: number,"sha256"?: string,"storage_path"?: string,"substituido_em"?: string | null,"substituido_por"?: string | null,"tamanho"?: number | null,"tipo"?: Database["public"]['Enums']["tipo_documento"],"versao"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "documentos_documento_original_id_fkey"
      columns: ["documento_original_id"]
isOneToOne: false
      referencedRelation: "documentos"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "documentos_enviado_por_fkey"
      columns: ["enviado_por"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "documentos_obra_id_fkey"
      columns: ["obra_id"]
isOneToOne: false
      referencedRelation: "obras"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "documentos_pagamento_id_fkey"
      columns: ["pagamento_id"]
isOneToOne: false
      referencedRelation: "pagamentos"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "documentos_substituido_por_fkey"
      columns: ["substituido_por"]
isOneToOne: false
      referencedRelation: "documentos"
      referencedColumns: ["id"]
    }
                  ]
                },"fornecedores": {
                  Row: {
                    "agencia": string | null,"ativo": boolean,"banco": string | null,"chave_pix": string | null,"cidade": string | null,"conta": string | null,"cpf_cnpj": string | null,"created_at": string,"created_by": string | null,"email": string | null,"id": string,"nome": string,"observacoes": string | null,"telefone": string | null,"uf": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "agencia"?: string | null,"ativo"?: boolean,"banco"?: string | null,"chave_pix"?: string | null,"cidade"?: string | null,"conta"?: string | null,"cpf_cnpj"?: string | null,"created_at"?: string,"created_by"?: string | null,"email"?: string | null,"id"?: string,"nome": string,"observacoes"?: string | null,"telefone"?: string | null,"uf"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "agencia"?: string | null,"ativo"?: boolean,"banco"?: string | null,"chave_pix"?: string | null,"cidade"?: string | null,"conta"?: string | null,"cpf_cnpj"?: string | null,"created_at"?: string,"created_by"?: string | null,"email"?: string | null,"id"?: string,"nome"?: string,"observacoes"?: string | null,"telefone"?: string | null,"uf"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "fornecedores_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"nf_itens": {
                  Row: {
                    "codigo": string | null,"descricao": string,"descricao_normalizada": string,"id": string,"ncm": string | null,"nota_id": string,"numero_item": number,"quantidade": number,"unidade": string | null,"valor_total": number,"valor_unitario": number
                  }
                  ComputedFields: never
                  Insert: {
                    "codigo"?: string | null,"descricao": string,"descricao_normalizada": string,"id"?: string,"ncm"?: string | null,"nota_id": string,"numero_item": number,"quantidade": number,"unidade"?: string | null,"valor_total": number,"valor_unitario": number
                  }
                  Update: {
                    "codigo"?: string | null,"descricao"?: string,"descricao_normalizada"?: string,"id"?: string,"ncm"?: string | null,"nota_id"?: string,"numero_item"?: number,"quantidade"?: number,"unidade"?: string | null,"valor_total"?: number,"valor_unitario"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "nf_itens_nota_id_fkey"
      columns: ["nota_id"]
isOneToOne: false
      referencedRelation: "nf_notas"
      referencedColumns: ["id"]
    }
                  ]
                },"nf_notas": {
                  Row: {
                    "ativa": boolean,"chave": string | null,"created_at": string,"created_by": string,"data_emissao": string,"documento_id": string,"emitente_cnpj": string | null,"emitente_nome": string,"emitente_uf": string | null,"id": string,"numero": string | null,"obra_id": string,"origem": string,"pagamento_id": string,"serie": string | null,"valor_desconto": number | null,"valor_frete": number | null,"valor_produtos": number | null,"valor_total": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "ativa"?: boolean,"chave"?: string | null,"created_at"?: string,"created_by"?: string,"data_emissao": string,"documento_id": string,"emitente_cnpj"?: string | null,"emitente_nome": string,"emitente_uf"?: string | null,"id"?: string,"numero"?: string | null,"obra_id": string,"origem": string,"pagamento_id": string,"serie"?: string | null,"valor_desconto"?: number | null,"valor_frete"?: number | null,"valor_produtos"?: number | null,"valor_total"?: number | null
                  }
                  Update: {
                    "ativa"?: boolean,"chave"?: string | null,"created_at"?: string,"created_by"?: string,"data_emissao"?: string,"documento_id"?: string,"emitente_cnpj"?: string | null,"emitente_nome"?: string,"emitente_uf"?: string | null,"id"?: string,"numero"?: string | null,"obra_id"?: string,"origem"?: string,"pagamento_id"?: string,"serie"?: string | null,"valor_desconto"?: number | null,"valor_frete"?: number | null,"valor_produtos"?: number | null,"valor_total"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "nf_notas_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "nf_notas_documento_id_fkey"
      columns: ["documento_id"]
isOneToOne: true
      referencedRelation: "documentos"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "nf_notas_obra_id_fkey"
      columns: ["obra_id"]
isOneToOne: false
      referencedRelation: "obras"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "nf_notas_pagamento_id_fkey"
      columns: ["pagamento_id"]
isOneToOne: false
      referencedRelation: "pagamentos"
      referencedColumns: ["id"]
    }
                  ]
                },"notificacoes": {
                  Row: {
                    "created_at": string,"id": string,"lida_em": string | null,"link": string | null,"mensagem": string | null,"pagamento_id": string | null,"titulo": string,"user_id": string,"whatsapp_enviado_em": string | null,"whatsapp_erro": string | null,"whatsapp_status": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"lida_em"?: string | null,"link"?: string | null,"mensagem"?: string | null,"pagamento_id"?: string | null,"titulo": string,"user_id": string,"whatsapp_enviado_em"?: string | null,"whatsapp_erro"?: string | null,"whatsapp_status"?: string | null
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"lida_em"?: string | null,"link"?: string | null,"mensagem"?: string | null,"pagamento_id"?: string | null,"titulo"?: string,"user_id"?: string,"whatsapp_enviado_em"?: string | null,"whatsapp_erro"?: string | null,"whatsapp_status"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "notificacoes_pagamento_id_fkey"
      columns: ["pagamento_id"]
isOneToOne: false
      referencedRelation: "pagamentos"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "notificacoes_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"obra_acessos": {
                  Row: {
                    "concedido_por": string | null,"created_at": string,"obra_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "concedido_por"?: string | null,"created_at"?: string,"obra_id": string,"user_id": string
                  }
                  Update: {
                    "concedido_por"?: string | null,"created_at"?: string,"obra_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "obra_acessos_concedido_por_fkey"
      columns: ["concedido_por"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "obra_acessos_obra_id_fkey"
      columns: ["obra_id"]
isOneToOne: false
      referencedRelation: "obras"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "obra_acessos_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"obras": {
                  Row: {
                    "administrador_id": string | null,"cidade": string,"cliente": string | null,"codigo": string | null,"created_at": string,"created_by": string | null,"endereco": string | null,"engenheiro_id": string | null,"fluxo": Database["public"]['Enums']["fluxo_aprovacao"],"id": string,"nome": string,"observacoes": string | null,"status": Database["public"]['Enums']["status_obra"],"uf": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "administrador_id"?: string | null,"cidade": string,"cliente"?: string | null,"codigo"?: string | null,"created_at"?: string,"created_by"?: string | null,"endereco"?: string | null,"engenheiro_id"?: string | null,"fluxo"?: Database["public"]['Enums']["fluxo_aprovacao"],"id"?: string,"nome": string,"observacoes"?: string | null,"status"?: Database["public"]['Enums']["status_obra"],"uf": string,"updated_at"?: string
                  }
                  Update: {
                    "administrador_id"?: string | null,"cidade"?: string,"cliente"?: string | null,"codigo"?: string | null,"created_at"?: string,"created_by"?: string | null,"endereco"?: string | null,"engenheiro_id"?: string | null,"fluxo"?: Database["public"]['Enums']["fluxo_aprovacao"],"id"?: string,"nome"?: string,"observacoes"?: string | null,"status"?: Database["public"]['Enums']["status_obra"],"uf"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "obras_administrador_id_fkey"
      columns: ["administrador_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "obras_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "obras_engenheiro_id_fkey"
      columns: ["engenheiro_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"ordem_itens": {
                  Row: {
                    "descricao": string,"id": string,"inicio": string | null,"ordem_id": string,"posicao": number,"quantidade": number,"salario": number | null,"total": number | null,"unidade": string | null,"valor_unitario": number
                  }
                  ComputedFields: never
                  Insert: {
                    "descricao": string,"id"?: string,"inicio"?: string | null,"ordem_id": string,"posicao": number,"quantidade": number,"salario"?: number | null,"total"?: never,"unidade"?: string | null,"valor_unitario": number
                  }
                  Update: {
                    "descricao"?: string,"id"?: string,"inicio"?: string | null,"ordem_id"?: string,"posicao"?: number,"quantidade"?: number,"salario"?: number | null,"total"?: never,"unidade"?: string | null,"valor_unitario"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "ordem_itens_ordem_id_fkey"
      columns: ["ordem_id"]
isOneToOne: false
      referencedRelation: "ordens_pagamento"
      referencedColumns: ["id"]
    }
                  ]
                },"ordens_pagamento": {
                  Row: {
                    "analisada_em": string | null,"cpf_cnpj": string | null,"created_at": string,"dados_bancarios": string | null,"desconto": number,"descricao": string,"enviada_em": string | null,"favorecido": string,"forma_pagamento": Database["public"]['Enums']["forma_pagamento"],"fornecedor_id": string | null,"id": string,"numero": string | null,"obra_id": string,"observacoes": string | null,"referencia": string | null,"solicitante_id": string,"status": Database["public"]['Enums']["status_op"],"updated_at": string,"vencimento": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "analisada_em"?: string | null,"cpf_cnpj"?: string | null,"created_at"?: string,"dados_bancarios"?: string | null,"desconto"?: number,"descricao": string,"enviada_em"?: string | null,"favorecido": string,"forma_pagamento"?: Database["public"]['Enums']["forma_pagamento"],"fornecedor_id"?: string | null,"id"?: string,"numero"?: string | null,"obra_id": string,"observacoes"?: string | null,"referencia"?: string | null,"solicitante_id"?: string,"status"?: Database["public"]['Enums']["status_op"],"updated_at"?: string,"vencimento"?: string | null
                  }
                  Update: {
                    "analisada_em"?: string | null,"cpf_cnpj"?: string | null,"created_at"?: string,"dados_bancarios"?: string | null,"desconto"?: number,"descricao"?: string,"enviada_em"?: string | null,"favorecido"?: string,"forma_pagamento"?: Database["public"]['Enums']["forma_pagamento"],"fornecedor_id"?: string | null,"id"?: string,"numero"?: string | null,"obra_id"?: string,"observacoes"?: string | null,"referencia"?: string | null,"solicitante_id"?: string,"status"?: Database["public"]['Enums']["status_op"],"updated_at"?: string,"vencimento"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "ordens_pagamento_fornecedor_id_fkey"
      columns: ["fornecedor_id"]
isOneToOne: false
      referencedRelation: "fornecedores"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "ordens_pagamento_obra_id_fkey"
      columns: ["obra_id"]
isOneToOne: false
      referencedRelation: "obras"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "ordens_pagamento_solicitante_id_fkey"
      columns: ["solicitante_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"pagamentos": {
                  Row: {
                    "cancelamento_motivo": string | null,"created_at": string,"created_by": string,"descricao": string,"favorecido": string,"fluxo": Database["public"]['Enums']["fluxo_aprovacao"],"forma_pagamento": Database["public"]['Enums']["forma_pagamento"],"fornecedor_id": string | null,"id": string,"numero": number,"numero_documento": string | null,"obra_id": string,"observacoes": string | null,"ordem_id": string | null,"pago_em": string | null,"pago_por": string | null,"rejeicao_motivo": string | null,"status": Database["public"]['Enums']["status_pagamento"],"updated_at": string,"valor": number,"valor_pago": number | null,"vencimento": string,"versao": number
                  }
                  ComputedFields: never
                  Insert: {
                    "cancelamento_motivo"?: string | null,"created_at"?: string,"created_by": string,"descricao": string,"favorecido": string,"fluxo": Database["public"]['Enums']["fluxo_aprovacao"],"forma_pagamento"?: Database["public"]['Enums']["forma_pagamento"],"fornecedor_id"?: string | null,"id"?: string,"numero"?: never,"numero_documento"?: string | null,"obra_id": string,"observacoes"?: string | null,"ordem_id"?: string | null,"pago_em"?: string | null,"pago_por"?: string | null,"rejeicao_motivo"?: string | null,"status": Database["public"]['Enums']["status_pagamento"],"updated_at"?: string,"valor": number,"valor_pago"?: number | null,"vencimento": string,"versao"?: number
                  }
                  Update: {
                    "cancelamento_motivo"?: string | null,"created_at"?: string,"created_by"?: string,"descricao"?: string,"favorecido"?: string,"fluxo"?: Database["public"]['Enums']["fluxo_aprovacao"],"forma_pagamento"?: Database["public"]['Enums']["forma_pagamento"],"fornecedor_id"?: string | null,"id"?: string,"numero"?: never,"numero_documento"?: string | null,"obra_id"?: string,"observacoes"?: string | null,"ordem_id"?: string | null,"pago_em"?: string | null,"pago_por"?: string | null,"rejeicao_motivo"?: string | null,"status"?: Database["public"]['Enums']["status_pagamento"],"updated_at"?: string,"valor"?: number,"valor_pago"?: number | null,"vencimento"?: string,"versao"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "pagamentos_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "pagamentos_fornecedor_id_fkey"
      columns: ["fornecedor_id"]
isOneToOne: false
      referencedRelation: "fornecedores"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "pagamentos_obra_id_fkey"
      columns: ["obra_id"]
isOneToOne: false
      referencedRelation: "obras"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "pagamentos_ordem_id_fkey"
      columns: ["ordem_id"]
isOneToOne: true
      referencedRelation: "ordens_pagamento"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "pagamentos_pago_por_fkey"
      columns: ["pago_por"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "ativo": boolean,"created_at": string,"email": string,"id": string,"nome": string,"perfil": Database["public"]['Enums']["perfil_usuario"],"telefone": string | null,"troca_senha_pendente": boolean,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "ativo"?: boolean,"created_at"?: string,"email": string,"id": string,"nome": string,"perfil": Database["public"]['Enums']["perfil_usuario"],"telefone"?: string | null,"troca_senha_pendente"?: boolean,"updated_at"?: string
                  }
                  Update: {
                    "ativo"?: boolean,"created_at"?: string,"email"?: string,"id"?: string,"nome"?: string,"perfil"?: Database["public"]['Enums']["perfil_usuario"],"telefone"?: string | null,"troca_senha_pendente"?: boolean,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            "compras_itens": {
                  Row: {
                    "cidade": string,"codigo": string | null,"data_emissao": string,"descricao": string,"descricao_normalizada": string,"documento_id": string,"fornecedor_cnpj": string | null,"fornecedor_nome": string,"id": string,"ncm": string | null,"nf_numero": string | null,"nota_id": string,"numero_item": number,"obra_id": string,"obra_nome": string,"origem": string,"pagamento_id": string,"quantidade": number,"uf": string,"unidade": string | null,"valor_total": number,"valor_unitario": number
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "nf_itens_nota_id_fkey"
      columns: ["nota_id"]
isOneToOne: false
      referencedRelation: "nf_notas"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "nf_notas_documento_id_fkey"
      columns: ["documento_id"]
isOneToOne: true
      referencedRelation: "documentos"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "nf_notas_obra_id_fkey"
      columns: ["obra_id"]
isOneToOne: false
      referencedRelation: "obras"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "nf_notas_pagamento_id_fkey"
      columns: ["pagamento_id"]
isOneToOne: false
      referencedRelation: "pagamentos"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Functions: {
            "_auditar":
{ Args: { "p_acao": string,"p_antes"?: Json,"p_depois"?: Json,"p_descricao": string,"p_entidade": string,"p_entidade_id": string,"p_obra_id"?: string,"p_pagamento_id"?: string }; Returns: undefined
                           },
"_conteudo_assinavel":
{ Args: { "p_pagamento_id": string }; Returns: Json
                           },
"_diff_jsonb":
{ Args: { "p_antes": Json,"p_depois": Json }; Returns: Record<string, unknown>
                           },
"_notificar":
{ Args: { "p_link": string,"p_mensagem": string,"p_pagamento_id"?: string,"p_titulo": string,"p_user_id": string }; Returns: undefined
                           },
"_notificar_etapa":
{ Args: { "p_pagamento_id": string }; Returns: undefined
                           },
"_notificar_financeiro":
{ Args: { "p_link": string,"p_mensagem": string,"p_pagamento_id"?: string,"p_titulo": string }; Returns: undefined
                           },
"_nova_versao":
{ Args: { "p_motivo": string,"p_pagamento_id": string }; Returns: undefined
                           },
"_status_inicial":
{ Args: { "p_fluxo": Database["public"]['Enums']["fluxo_aprovacao"] }; Returns: Database["public"]['Enums']["status_pagamento"]
                           },
"_uuid_ou_nulo":
{ Args: { "p_texto": string }; Returns: string
                           },
"atualizar_pagamento":
{ Args: { "p_descricao": string,"p_favorecido": string,"p_forma_pagamento": Database["public"]['Enums']["forma_pagamento"],"p_fornecedor_id": string,"p_id": string,"p_motivo"?: string,"p_numero_documento": string,"p_observacoes": string,"p_valor": number,"p_vencimento": string }; Returns: undefined
                           },
"cancelar_pagamento":
{ Args: { "p_id": string,"p_motivo": string }; Returns: undefined
                           },
"confirmar_troca_senha":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"criar_pagamento":
{ Args: { "p_descricao": string,"p_favorecido": string,"p_forma_pagamento": Database["public"]['Enums']["forma_pagamento"],"p_fornecedor_id": string,"p_numero_documento"?: string,"p_obra_id": string,"p_observacoes"?: string,"p_valor": number,"p_vencimento": string }; Returns: string
                           },
"decidir_aprovacao":
{ Args: { "p_comentario"?: string,"p_decisao": Database["public"]['Enums']["decisao_aprovacao"],"p_ip"?: string,"p_itens": Json,"p_user_agent"?: string }; Returns: string
                           },
"enviar_op":
{ Args: { "p_id": string }; Returns: string
                           },
"excluir_op":
{ Args: { "p_id": string }; Returns: undefined
                           },
"gerar_lembretes_diarios":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"is_financeiro":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"marcar_notificacoes_lidas":
{ Args: { "p_ids"?: (string)[] }; Returns: undefined
                           },
"marcar_op_em_analise":
{ Args: { "p_pagamento_id": string }; Returns: undefined
                           },
"meu_perfil":
{ Args: Record<PropertyKey, never>; Returns: Database["public"]['Enums']["perfil_usuario"]
                           },
"minhas_pendencias":
{ Args: Record<PropertyKey, never>; Returns: {
              "cancelamento_motivo": string | null,
"created_at": string,
"created_by": string,
"descricao": string,
"favorecido": string,
"fluxo": Database["public"]['Enums']["fluxo_aprovacao"],
"forma_pagamento": Database["public"]['Enums']["forma_pagamento"],
"fornecedor_id": string | null,
"id": string,
"numero": number,
"numero_documento": string | null,
"obra_id": string,
"observacoes": string | null,
"ordem_id": string | null,
"pago_em": string | null,
"pago_por": string | null,
"rejeicao_motivo": string | null,
"status": Database["public"]['Enums']["status_pagamento"],
"updated_at": string,
"valor": number,
"valor_pago": number | null,
"vencimento": string,
"versao": number
            }[]
                          SetofOptions: {
        from: "*"
        to: "pagamentos"
        isOneToOne: false
        isSetofReturn: true
      } },
"pode_atuar_obra":
{ Args: { "p_obra_id": string }; Returns: boolean
                           },
"pode_baixar":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"pode_enviar_arquivo":
{ Args: { "p_nome": string }; Returns: boolean
                           },
"pode_ver_obra":
{ Args: { "p_obra_id": string }; Returns: boolean
                           },
"reenviar_pagamento":
{ Args: { "p_id": string,"p_observacao"?: string }; Returns: undefined
                           },
"registrar_baixa":
{ Args: { "p_id": string,"p_observacao"?: string,"p_pago_em": string,"p_valor_pago"?: number }; Returns: undefined
                           },
"registrar_documento":
{ Args: { "p_mime_type": string,"p_motivo"?: string,"p_nome_arquivo": string,"p_pagamento_id": string,"p_sha256": string,"p_storage_path": string,"p_substitui_id"?: string,"p_tamanho": number,"p_tipo": Database["public"]['Enums']["tipo_documento"] }; Returns: string
                           },
"registrar_nf":
{ Args: { "p_documento_id": string,"p_itens": Json,"p_nota": Json,"p_origem": string }; Returns: string
                           },
"remover_nf":
{ Args: { "p_nota_id": string }; Returns: undefined
                           },
"salvar_op":
{ Args: { "p_cpf_cnpj": string,"p_dados_bancarios": string,"p_desconto"?: number,"p_descricao": string,"p_favorecido": string,"p_forma_pagamento": Database["public"]['Enums']["forma_pagamento"],"p_id": string,"p_itens": Json,"p_obra_id": string,"p_observacoes": string,"p_referencia"?: string,"p_vencimento": string }; Returns: string
                           }
          }
          Enums: {
            "decisao_aprovacao": "aprovado"|"rejeitado","etapa_aprovacao": "engenheiro"|"administrador","fluxo_aprovacao": "A"|"B"|"C","forma_pagamento": "boleto"|"pix"|"transferencia"|"dinheiro"|"cartao"|"outro","perfil_usuario": "financeiro"|"suprimentos"|"engenheiro"|"administrador"|"administrador_master","status_obra": "ativa"|"suspensa"|"concluida","status_op": "em_elaboracao"|"enviada"|"em_analise"|"aprovada"|"rejeitada"|"paga"|"cancelada","status_pagamento": "aguardando_engenheiro"|"aguardando_administrador"|"aguardando_pagamento"|"pago"|"rejeitado"|"cancelado","tipo_documento": "boleto"|"nota_fiscal"|"ordem_pagamento"|"comprovante"|"outro"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

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
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
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
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
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
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
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
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
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
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {
            
          }
        },"public": {
          Enums: {
            "decisao_aprovacao": ["aprovado", "rejeitado"],"etapa_aprovacao": ["engenheiro", "administrador"],"fluxo_aprovacao": ["A", "B", "C"],"forma_pagamento": ["boleto", "pix", "transferencia", "dinheiro", "cartao", "outro"],"perfil_usuario": ["financeiro", "suprimentos", "engenheiro", "administrador", "administrador_master"],"status_obra": ["ativa", "suspensa", "concluida"],"status_op": ["em_elaboracao", "enviada", "em_analise", "aprovada", "rejeitada", "paga", "cancelada"],"status_pagamento": ["aguardando_engenheiro", "aguardando_administrador", "aguardando_pagamento", "pago", "rejeitado", "cancelado"],"tipo_documento": ["boleto", "nota_fiscal", "ordem_pagamento", "comprovante", "outro"]
          }
        }
} as const
