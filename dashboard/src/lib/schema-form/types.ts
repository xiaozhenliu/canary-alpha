export interface JsonSchemaNode {
  type?: string;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  enum?: string[];
  default?: unknown;
  description?: string;
  required?: string[];
  nullable?: boolean;
  minimum?: number;
  format?: string;
  isSecret?: boolean;
}

export interface FieldProps {
  path: string;
  schema: JsonSchemaNode;
  value: unknown;
  onChange: (path: string, value: unknown) => void;
}
