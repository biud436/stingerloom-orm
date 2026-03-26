import {
  PrismaModelInfo,
  PrismaFieldInfo,
  PrismaImportContext,
} from "./PrismaSchemaAnalyzer";
import { camelToSnakeCase } from "../../utils/camelToSnakeCase";

/**
 * Resolved relation information for code generation.
 */
export type ResolvedRelation =
  | ManyToOneRelation
  | OneToManyRelation
  | OneToOneOwningRelation
  | OneToOneInverseRelation
  | ManyToManyOwningRelation
  | ManyToManyInverseRelation;

export interface ManyToOneRelation {
  kind: "ManyToOne";
  propertyName: string;
  targetModel: string;
  joinColumn: string;
  references?: string;
  cascade?: string[];
  onDelete?: string;
  onUpdate?: string;
}

export interface OneToManyRelation {
  kind: "OneToMany";
  propertyName: string;
  targetModel: string;
  mappedBy: string;
}

export interface OneToOneOwningRelation {
  kind: "OneToOneOwning";
  propertyName: string;
  targetModel: string;
  joinColumn: string;
  references?: string;
  cascade?: string[];
  onDelete?: string;
  onUpdate?: string;
}

export interface OneToOneInverseRelation {
  kind: "OneToOneInverse";
  propertyName: string;
  targetModel: string;
  inverseSide: string;
}

export interface ManyToManyOwningRelation {
  kind: "ManyToManyOwning";
  propertyName: string;
  targetModel: string;
  joinTableName: string;
  joinColumn: string;
  inverseJoinColumn: string;
}

export interface ManyToManyInverseRelation {
  kind: "ManyToManyInverse";
  propertyName: string;
  targetModel: string;
  mappedBy: string;
}

/**
 * Resolves Prisma relation fields into stingerloom ORM relation types.
 */
export class RelationResolver {
  private modelMap: Map<string, PrismaModelInfo> = new Map();

  resolve(context: PrismaImportContext): Map<string, ResolvedRelation[]> {
    const result = new Map<string, ResolvedRelation[]>();

    for (const model of context.models) {
      this.modelMap.set(model.name, model);
      result.set(model.name, []);
    }

    // First pass: identify all relation field pairs
    for (const model of context.models) {
      for (const field of model.fields) {
        if (!this.isRelationField(field, context)) continue;

        const relations = result.get(model.name)!;

        // Skip if already resolved (e.g., inverse side added when resolving owning side)
        if (relations.some((r) => r.propertyName === field.name)) continue;

        const resolved = this.resolveField(model, field, context);
        if (resolved) {
          relations.push(resolved);
        }
      }
    }

    return result;
  }

  private isRelationField(
    field: PrismaFieldInfo,
    context: PrismaImportContext,
  ): boolean {
    const modelNames = new Set(context.models.map((m) => m.name));
    return modelNames.has(field.fieldType);
  }

  private resolveField(
    model: PrismaModelInfo,
    field: PrismaFieldInfo,
    context: PrismaImportContext,
  ): ResolvedRelation | undefined {
    const targetModel = this.modelMap.get(field.fieldType);
    if (!targetModel) return undefined;

    // Case 1: Field has @relation(fields: [...], references: [...]) → owning side
    if (field.relation?.fields && field.relation.fields.length > 0) {
      return this.resolveOwningSide(model, field, targetModel, context);
    }

    // Case 2: Array field (list type)
    if (field.isArray) {
      return this.resolveListSide(model, field, targetModel, context);
    }

    // Case 3: Non-array, no relation fields → inverse side of 1:1
    if (!field.isArray && !field.relation?.fields) {
      return this.resolveInverseSide(model, field, targetModel);
    }

    return undefined;
  }

  private resolveOwningSide(
    model: PrismaModelInfo,
    field: PrismaFieldInfo,
    targetModel: PrismaModelInfo,
    _context: PrismaImportContext,
  ): ResolvedRelation {
    const fkFieldNames = field.relation!.fields!;
    const fkField = model.fields.find((f) => f.name === fkFieldNames[0]);
    const isUnique = fkField?.isUnique ?? false;

    const joinColumn = fkField?.columnName ?? fkFieldNames[0];
    const references =
      field.relation!.references &&
      field.relation!.references[0] !== "id"
        ? field.relation!.references[0]
        : undefined;

    const cascade = this.extractCascade(field);
    const onDelete = this.mapReferentialAction(field.relation?.onDelete);
    const onUpdate = this.mapReferentialAction(field.relation?.onUpdate);

    if (isUnique) {
      // 1:1 owning side
      return {
        kind: "OneToOneOwning",
        propertyName: field.name,
        targetModel: targetModel.name,
        joinColumn,
        references,
        cascade,
        onDelete,
        onUpdate,
      };
    }

    // M:1 owning side
    return {
      kind: "ManyToOne",
      propertyName: field.name,
      targetModel: targetModel.name,
      joinColumn,
      references,
      cascade,
      onDelete,
      onUpdate,
    };
  }

  private resolveListSide(
    model: PrismaModelInfo,
    field: PrismaFieldInfo,
    targetModel: PrismaModelInfo,
    _context: PrismaImportContext,
  ): ResolvedRelation | undefined {
    // Check if target has a matching owning field pointing back to this model
    const counterpartOwning = this.findCounterpartOwning(
      model,
      field,
      targetModel,
    );

    if (counterpartOwning) {
      // Check if target side is also a list → implicit M:N
      const targetField = targetModel.fields.find(
        (f) =>
          f.fieldType === model.name && f.isArray,
      );

      if (targetField && !counterpartOwning.relation?.fields) {
        // Both are lists with no relation fields = implicit M:N
        // Only create owning side for alphabetically first model
        return this.resolveImplicitManyToMany(model, field, targetModel, targetField);
      }

      // 1:N inverse side
      return {
        kind: "OneToMany",
        propertyName: field.name,
        targetModel: targetModel.name,
        mappedBy: counterpartOwning.name,
      };
    }

    // Check for implicit M:N (both sides are lists, no @relation fields/references)
    const counterpartList = targetModel.fields.find(
      (f) =>
        f.fieldType === model.name && f.isArray,
    );
    if (counterpartList) {
      return this.resolveImplicitManyToMany(model, field, targetModel, counterpartList);
    }

    return undefined;
  }

  private resolveImplicitManyToMany(
    model: PrismaModelInfo,
    field: PrismaFieldInfo,
    targetModel: PrismaModelInfo,
    targetField: PrismaFieldInfo,
  ): ResolvedRelation {
    // Alphabetically first model is the owning side
    const [first, second] = [model.name, targetModel.name].sort();
    const isOwning = model.name === first;

    if (isOwning) {
      const joinTableName = `${camelToSnakeCase(first)}_${camelToSnakeCase(second)}`;
      return {
        kind: "ManyToManyOwning",
        propertyName: field.name,
        targetModel: targetModel.name,
        joinTableName,
        joinColumn: `${camelToSnakeCase(first)}_id`,
        inverseJoinColumn: `${camelToSnakeCase(second)}_id`,
      };
    }

    // Inverse side: find owning property name on the target
    return {
      kind: "ManyToManyInverse",
      propertyName: field.name,
      targetModel: targetModel.name,
      mappedBy: targetField.name,
    };
  }

  private resolveInverseSide(
    _model: PrismaModelInfo,
    field: PrismaFieldInfo,
    targetModel: PrismaModelInfo,
  ): ResolvedRelation | undefined {
    // Find the owning field on the target model
    const owning = this.findCounterpartOwning(
      { name: field.fieldType } as PrismaModelInfo,
      field,
      targetModel,
    );

    if (!owning) {
      // Look for owning side on the target that references our model
      const targetOwning = targetModel.fields.find(
        (f) =>
          f.fieldType === (field as any).__modelName &&
          f.relation?.fields &&
          f.relation.fields.length > 0,
      );
      if (targetOwning) {
        return {
          kind: "OneToOneInverse",
          propertyName: field.name,
          targetModel: targetModel.name,
          inverseSide: targetOwning.name,
        };
      }
    }

    return undefined;
  }

  private findCounterpartOwning(
    model: PrismaModelInfo,
    field: PrismaFieldInfo,
    targetModel: PrismaModelInfo,
  ): PrismaFieldInfo | undefined {
    // Find a field on targetModel that has @relation(fields:[...]) pointing to our model
    const candidates = targetModel.fields.filter(
      (f) =>
        f.fieldType === model.name &&
        f.relation?.fields &&
        f.relation.fields.length > 0,
    );

    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) return candidates[0];

    // Multiple relations → match by relation name
    if (field.relation?.name) {
      return candidates.find((c) => c.relation?.name === field.relation?.name);
    }

    return candidates[0];
  }

  private extractCascade(field: PrismaFieldInfo): string[] | undefined {
    const onDelete = field.relation?.onDelete;
    if (!onDelete) return undefined;

    if (onDelete === "Cascade") return ["delete"];
    return undefined;
  }

  /**
   * Map Prisma referential action names to SQL standard values.
   */
  private mapReferentialAction(
    prismaAction: string | undefined,
  ): string | undefined {
    if (!prismaAction) return undefined;
    const map: Record<string, string> = {
      Cascade: "CASCADE",
      SetNull: "SET NULL",
      SetDefault: "SET DEFAULT",
      Restrict: "RESTRICT",
      NoAction: "NO ACTION",
    };
    return map[prismaAction];
  }
}
