"""Schema generation and validation for OpenAI forms."""

from __future__ import annotations

from openai_mcp_form_protocol import FormField, FormSchema
from pydantic import BaseModel
from pydantic.json_schema import GenerateJsonSchema, JsonSchemaValue
from pydantic_core import core_schema


class _FormJsonSchema(GenerateJsonSchema):
    def model_field_schema(self, schema: core_schema.ModelField) -> JsonSchemaValue:
        alias = schema.get("validation_alias")
        if isinstance(alias, list) and not any(
            isinstance(path, list) and len(path) == 1 and isinstance(path[0], str) for path in alias
        ):
            raise ValueError("Form fields must use flat validation aliases")
        return super().model_field_schema(schema)

    def nullable_schema(self, schema: core_schema.NullableSchema) -> JsonSchemaValue:
        # Optional form fields are omitted rather than submitted as null.
        return self.generate_inner(schema["schema"])

    def model_fields_schema(self, schema: core_schema.ModelFieldsSchema) -> JsonSchemaValue:
        result = super().model_fields_schema(schema)
        for field in result["properties"].values():
            if field.get("default") is None:
                field.pop("default", None)
        return result

    def literal_schema(self, schema: core_schema.LiteralSchema) -> JsonSchemaValue:
        result = super().literal_schema(schema)
        if result.get("type") == "string" and "const" in result:
            result["enum"] = [result.pop("const")]
        return result


def render_form_schema(model: type[BaseModel]) -> JsonSchemaValue:
    form = model.model_json_schema(by_alias=True, schema_generator=_FormJsonSchema)
    FormSchema[FormField].model_validate(form)
    return form
