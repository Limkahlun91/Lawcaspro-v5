export type FieldMappingTargetType =
  | "case.referenceNo"
  | "case.parcelNo"
  | "case.caseType"
  | "case.spaPrice"
  | "case.apdlPrice"
  | "case.developerDiscount"
  | "case.bumiputraDiscount"
  | "case.titleType"
  | "case.purchaseMode"
  | "case.assignedLawyerId"
  | "case.assignedClerkId"
  | "case.projectId"
  | "case.developerId"
  | "purchaser.name"
  | "purchaser.ic"
  | "purchaser.phone"
  | "purchaser.email"
  | "purchaser.address"
  | "purchaser.addressLine1"
  | "purchaser.addressLine2"
  | "purchaser.addressLine3"
  | "purchaser.addressLine4"
  | "purchaser.addressLine5"
  | "borrower.name"
  | "borrower.ic"
  | "borrower.tin"
  | "borrower.hp"
  | "borrower.email"
  | "borrower.address"
  | "borrower.addressLine1"
  | "borrower.addressLine2"
  | "borrower.addressLine3"
  | "borrower.addressLine4"
  | "borrower.addressLine5"
  | "borrower.postcode"
  | "borrower.city"
  | "borrower.state"
  | "property.propertyAddress"
  | "property.propertyType"
  | "property.areaSqm"
  | "property.description"
  | "property.titleText"
  | "property.lotNo"
  | "property.hakmilikNo"
  | "financing.endFinancierBank"
  | "financing.bankRef"
  | "financing.branchAddressRaw"
  | "financing.propertyFinancingSum"
  | "financing.mrtaMrttRaw"
  | "financing.loanAmount"
  | "keydate.spa_date"
  | "keydate.spa_stamped_date"
  | "keydate.letter_of_offer_date"
  | "keydate.loan_docs_signed_date"
  | "keydate.completion_date"
  | "IGNORE"
  | "LEGACY_SNAPSHOT_ONLY";

export type FieldMappingGroup =
  | "Core Case"
  | "Purchaser"
  | "Borrower"
  | "Property"
  | "Financing"
  | "Existing Dates / Milestones"
  | "Other";

export type FieldCatalogEntry = {
  target: FieldMappingTargetType;
  group: FieldMappingGroup;
  label: string;
  dataType:
    | "string"
    | "number"
    | "date"
    | "boolean"
    | "user"
    | "project"
    | "developer";
  arrayIndex?: number;
  description?: string;
  optional?: boolean;
};

export const LEGACY_FIELD_CATALOG: FieldCatalogEntry[] = [
  { target: "case.referenceNo", group: "Core Case", label: "Case Reference No", dataType: "string", description: "Internal case reference number" },
  { target: "case.parcelNo", group: "Core Case", label: "Parcel No", dataType: "string", description: "Parcel / Lot identifier" },
  { target: "case.caseType", group: "Core Case", label: "Case Type", dataType: "string", description: "Conveyancing, loan, etc." },
  { target: "case.spaPrice", group: "Core Case", label: "SPA Price", dataType: "number", description: "Sale and Purchase Agreement price" },
  { target: "case.apdlPrice", group: "Core Case", label: "APDL Price", dataType: "number", optional: true },
  { target: "case.developerDiscount", group: "Core Case", label: "Developer Discount", dataType: "number", optional: true },
  { target: "case.bumiputraDiscount", group: "Core Case", label: "Bumiputra Discount", dataType: "number", optional: true },
  { target: "case.titleType", group: "Core Case", label: "Title Type", dataType: "string", optional: true },
  { target: "case.purchaseMode", group: "Core Case", label: "Purchase Mode", dataType: "string", optional: true },
  { target: "case.assignedLawyerId", group: "Core Case", label: "Assigned Lawyer", dataType: "user", optional: true },
  { target: "case.assignedClerkId", group: "Core Case", label: "Assigned Clerk", dataType: "user", optional: true },
  { target: "case.projectId", group: "Core Case", label: "Project", dataType: "project", optional: true },
  { target: "case.developerId", group: "Core Case", label: "Developer", dataType: "developer", optional: true },

  { target: "purchaser.name", group: "Purchaser", label: "Purchaser 1 Name", dataType: "string", arrayIndex: 0 },
  { target: "purchaser.ic", group: "Purchaser", label: "Purchaser 1 IC / Company No", dataType: "string", arrayIndex: 0 },
  { target: "purchaser.phone", group: "Purchaser", label: "Purchaser 1 Phone", dataType: "string", arrayIndex: 0, optional: true },
  { target: "purchaser.email", group: "Purchaser", label: "Purchaser 1 Email", dataType: "string", arrayIndex: 0, optional: true },
  { target: "purchaser.address", group: "Purchaser", label: "Purchaser 1 Address", dataType: "string", arrayIndex: 0, optional: true },
  { target: "purchaser.addressLine1", group: "Purchaser", label: "Purchaser 1 Address Line 1", dataType: "string", arrayIndex: 0, optional: true },
  { target: "purchaser.addressLine2", group: "Purchaser", label: "Purchaser 1 Address Line 2", dataType: "string", arrayIndex: 0, optional: true },
  { target: "purchaser.addressLine3", group: "Purchaser", label: "Purchaser 1 Address Line 3", dataType: "string", arrayIndex: 0, optional: true },
  { target: "purchaser.addressLine4", group: "Purchaser", label: "Purchaser 1 Address Line 4", dataType: "string", arrayIndex: 0, optional: true },
  { target: "purchaser.addressLine5", group: "Purchaser", label: "Purchaser 1 Address Line 5", dataType: "string", arrayIndex: 0, optional: true },

  { target: "purchaser.name", group: "Purchaser", label: "Purchaser 2 Name", dataType: "string", arrayIndex: 1 },
  { target: "purchaser.ic", group: "Purchaser", label: "Purchaser 2 IC / Company No", dataType: "string", arrayIndex: 1 },
  { target: "purchaser.phone", group: "Purchaser", label: "Purchaser 2 Phone", dataType: "string", arrayIndex: 1, optional: true },
  { target: "purchaser.email", group: "Purchaser", label: "Purchaser 2 Email", dataType: "string", arrayIndex: 1, optional: true },
  { target: "purchaser.address", group: "Purchaser", label: "Purchaser 2 Address", dataType: "string", arrayIndex: 1, optional: true },
  { target: "purchaser.addressLine1", group: "Purchaser", label: "Purchaser 2 Address Line 1", dataType: "string", arrayIndex: 1, optional: true },
  { target: "purchaser.addressLine2", group: "Purchaser", label: "Purchaser 2 Address Line 2", dataType: "string", arrayIndex: 1, optional: true },
  { target: "purchaser.addressLine3", group: "Purchaser", label: "Purchaser 2 Address Line 3", dataType: "string", arrayIndex: 1, optional: true },
  { target: "purchaser.addressLine4", group: "Purchaser", label: "Purchaser 2 Address Line 4", dataType: "string", arrayIndex: 1, optional: true },
  { target: "purchaser.addressLine5", group: "Purchaser", label: "Purchaser 2 Address Line 5", dataType: "string", arrayIndex: 1, optional: true },

  { target: "purchaser.name", group: "Purchaser", label: "Purchaser 3 Name", dataType: "string", arrayIndex: 2 },
  { target: "purchaser.ic", group: "Purchaser", label: "Purchaser 3 IC / Company No", dataType: "string", arrayIndex: 2 },
  { target: "purchaser.phone", group: "Purchaser", label: "Purchaser 3 Phone", dataType: "string", arrayIndex: 2, optional: true },
  { target: "purchaser.email", group: "Purchaser", label: "Purchaser 3 Email", dataType: "string", arrayIndex: 2, optional: true },
  { target: "purchaser.address", group: "Purchaser", label: "Purchaser 3 Address", dataType: "string", arrayIndex: 2, optional: true },
  { target: "purchaser.addressLine1", group: "Purchaser", label: "Purchaser 3 Address Line 1", dataType: "string", arrayIndex: 2, optional: true },
  { target: "purchaser.addressLine2", group: "Purchaser", label: "Purchaser 3 Address Line 2", dataType: "string", arrayIndex: 2, optional: true },
  { target: "purchaser.addressLine3", group: "Purchaser", label: "Purchaser 3 Address Line 3", dataType: "string", arrayIndex: 2, optional: true },
  { target: "purchaser.addressLine4", group: "Purchaser", label: "Purchaser 3 Address Line 4", dataType: "string", arrayIndex: 2, optional: true },
  { target: "purchaser.addressLine5", group: "Purchaser", label: "Purchaser 3 Address Line 5", dataType: "string", arrayIndex: 2, optional: true },

  { target: "purchaser.name", group: "Purchaser", label: "Purchaser 4 Name", dataType: "string", arrayIndex: 3 },
  { target: "purchaser.ic", group: "Purchaser", label: "Purchaser 4 IC / Company No", dataType: "string", arrayIndex: 3 },
  { target: "purchaser.phone", group: "Purchaser", label: "Purchaser 4 Phone", dataType: "string", arrayIndex: 3, optional: true },
  { target: "purchaser.email", group: "Purchaser", label: "Purchaser 4 Email", dataType: "string", arrayIndex: 3, optional: true },
  { target: "purchaser.address", group: "Purchaser", label: "Purchaser 4 Address", dataType: "string", arrayIndex: 3, optional: true },
  { target: "purchaser.addressLine1", group: "Purchaser", label: "Purchaser 4 Address Line 1", dataType: "string", arrayIndex: 3, optional: true },
  { target: "purchaser.addressLine2", group: "Purchaser", label: "Purchaser 4 Address Line 2", dataType: "string", arrayIndex: 3, optional: true },
  { target: "purchaser.addressLine3", group: "Purchaser", label: "Purchaser 4 Address Line 3", dataType: "string", arrayIndex: 3, optional: true },
  { target: "purchaser.addressLine4", group: "Purchaser", label: "Purchaser 4 Address Line 4", dataType: "string", arrayIndex: 3, optional: true },
  { target: "purchaser.addressLine5", group: "Purchaser", label: "Purchaser 4 Address Line 5", dataType: "string", arrayIndex: 3, optional: true },

  { target: "borrower.name", group: "Borrower", label: "Borrower 1 Name", dataType: "string", arrayIndex: 0 },
  { target: "borrower.ic", group: "Borrower", label: "Borrower 1 IC / Company No", dataType: "string", arrayIndex: 0 },
  { target: "borrower.tin", group: "Borrower", label: "Borrower 1 TIN", dataType: "string", arrayIndex: 0, optional: true },
  { target: "borrower.hp", group: "Borrower", label: "Borrower 1 HP", dataType: "string", arrayIndex: 0, optional: true },
  { target: "borrower.email", group: "Borrower", label: "Borrower 1 Email", dataType: "string", arrayIndex: 0, optional: true },
  { target: "borrower.address", group: "Borrower", label: "Borrower 1 Address", dataType: "string", arrayIndex: 0, optional: true },
  { target: "borrower.addressLine1", group: "Borrower", label: "Borrower 1 Address Line 1", dataType: "string", arrayIndex: 0, optional: true },
  { target: "borrower.addressLine2", group: "Borrower", label: "Borrower 1 Address Line 2", dataType: "string", arrayIndex: 0, optional: true },
  { target: "borrower.addressLine3", group: "Borrower", label: "Borrower 1 Address Line 3", dataType: "string", arrayIndex: 0, optional: true },
  { target: "borrower.addressLine4", group: "Borrower", label: "Borrower 1 Address Line 4", dataType: "string", arrayIndex: 0, optional: true },
  { target: "borrower.addressLine5", group: "Borrower", label: "Borrower 1 Address Line 5", dataType: "string", arrayIndex: 0, optional: true },
  { target: "borrower.postcode", group: "Borrower", label: "Borrower 1 Postcode", dataType: "string", arrayIndex: 0, optional: true },
  { target: "borrower.city", group: "Borrower", label: "Borrower 1 City", dataType: "string", arrayIndex: 0, optional: true },
  { target: "borrower.state", group: "Borrower", label: "Borrower 1 State", dataType: "string", arrayIndex: 0, optional: true },

  { target: "borrower.name", group: "Borrower", label: "Borrower 2 Name", dataType: "string", arrayIndex: 1 },
  { target: "borrower.ic", group: "Borrower", label: "Borrower 2 IC / Company No", dataType: "string", arrayIndex: 1 },
  { target: "borrower.tin", group: "Borrower", label: "Borrower 2 TIN", dataType: "string", arrayIndex: 1, optional: true },
  { target: "borrower.hp", group: "Borrower", label: "Borrower 2 HP", dataType: "string", arrayIndex: 1, optional: true },
  { target: "borrower.email", group: "Borrower", label: "Borrower 2 Email", dataType: "string", arrayIndex: 1, optional: true },
  { target: "borrower.address", group: "Borrower", label: "Borrower 2 Address", dataType: "string", arrayIndex: 1, optional: true },
  { target: "borrower.addressLine1", group: "Borrower", label: "Borrower 2 Address Line 1", dataType: "string", arrayIndex: 1, optional: true },
  { target: "borrower.addressLine2", group: "Borrower", label: "Borrower 2 Address Line 2", dataType: "string", arrayIndex: 1, optional: true },
  { target: "borrower.addressLine3", group: "Borrower", label: "Borrower 2 Address Line 3", dataType: "string", arrayIndex: 1, optional: true },
  { target: "borrower.addressLine4", group: "Borrower", label: "Borrower 2 Address Line 4", dataType: "string", arrayIndex: 1, optional: true },
  { target: "borrower.addressLine5", group: "Borrower", label: "Borrower 2 Address Line 5", dataType: "string", arrayIndex: 1, optional: true },
  { target: "borrower.postcode", group: "Borrower", label: "Borrower 2 Postcode", dataType: "string", arrayIndex: 1, optional: true },
  { target: "borrower.city", group: "Borrower", label: "Borrower 2 City", dataType: "string", arrayIndex: 1, optional: true },
  { target: "borrower.state", group: "Borrower", label: "Borrower 2 State", dataType: "string", arrayIndex: 1, optional: true },

  { target: "borrower.name", group: "Borrower", label: "Borrower 3 Name", dataType: "string", arrayIndex: 2 },
  { target: "borrower.ic", group: "Borrower", label: "Borrower 3 IC / Company No", dataType: "string", arrayIndex: 2 },
  { target: "borrower.tin", group: "Borrower", label: "Borrower 3 TIN", dataType: "string", arrayIndex: 2, optional: true },
  { target: "borrower.hp", group: "Borrower", label: "Borrower 3 HP", dataType: "string", arrayIndex: 2, optional: true },
  { target: "borrower.email", group: "Borrower", label: "Borrower 3 Email", dataType: "string", arrayIndex: 2, optional: true },
  { target: "borrower.address", group: "Borrower", label: "Borrower 3 Address", dataType: "string", arrayIndex: 2, optional: true },
  { target: "borrower.addressLine1", group: "Borrower", label: "Borrower 3 Address Line 1", dataType: "string", arrayIndex: 2, optional: true },
  { target: "borrower.addressLine2", group: "Borrower", label: "Borrower 3 Address Line 2", dataType: "string", arrayIndex: 2, optional: true },
  { target: "borrower.addressLine3", group: "Borrower", label: "Borrower 3 Address Line 3", dataType: "string", arrayIndex: 2, optional: true },
  { target: "borrower.addressLine4", group: "Borrower", label: "Borrower 3 Address Line 4", dataType: "string", arrayIndex: 2, optional: true },
  { target: "borrower.addressLine5", group: "Borrower", label: "Borrower 3 Address Line 5", dataType: "string", arrayIndex: 2, optional: true },
  { target: "borrower.postcode", group: "Borrower", label: "Borrower 3 Postcode", dataType: "string", arrayIndex: 2, optional: true },
  { target: "borrower.city", group: "Borrower", label: "Borrower 3 City", dataType: "string", arrayIndex: 2, optional: true },
  { target: "borrower.state", group: "Borrower", label: "Borrower 3 State", dataType: "string", arrayIndex: 2, optional: true },

  { target: "borrower.name", group: "Borrower", label: "Borrower 4 Name", dataType: "string", arrayIndex: 3 },
  { target: "borrower.ic", group: "Borrower", label: "Borrower 4 IC / Company No", dataType: "string", arrayIndex: 3 },
  { target: "borrower.tin", group: "Borrower", label: "Borrower 4 TIN", dataType: "string", arrayIndex: 3, optional: true },
  { target: "borrower.hp", group: "Borrower", label: "Borrower 4 HP", dataType: "string", arrayIndex: 3, optional: true },
  { target: "borrower.email", group: "Borrower", label: "Borrower 4 Email", dataType: "string", arrayIndex: 3, optional: true },
  { target: "borrower.address", group: "Borrower", label: "Borrower 4 Address", dataType: "string", arrayIndex: 3, optional: true },
  { target: "borrower.addressLine1", group: "Borrower", label: "Borrower 4 Address Line 1", dataType: "string", arrayIndex: 3, optional: true },
  { target: "borrower.addressLine2", group: "Borrower", label: "Borrower 4 Address Line 2", dataType: "string", arrayIndex: 3, optional: true },
  { target: "borrower.addressLine3", group: "Borrower", label: "Borrower 4 Address Line 3", dataType: "string", arrayIndex: 3, optional: true },
  { target: "borrower.addressLine4", group: "Borrower", label: "Borrower 4 Address Line 4", dataType: "string", arrayIndex: 3, optional: true },
  { target: "borrower.addressLine5", group: "Borrower", label: "Borrower 4 Address Line 5", dataType: "string", arrayIndex: 3, optional: true },
  { target: "borrower.postcode", group: "Borrower", label: "Borrower 4 Postcode", dataType: "string", arrayIndex: 3, optional: true },
  { target: "borrower.city", group: "Borrower", label: "Borrower 4 City", dataType: "string", arrayIndex: 3, optional: true },
  { target: "borrower.state", group: "Borrower", label: "Borrower 4 State", dataType: "string", arrayIndex: 3, optional: true },

  { target: "property.propertyAddress", group: "Property", label: "Property Address", dataType: "string", optional: true },
  { target: "property.propertyType", group: "Property", label: "Property Type", dataType: "string", optional: true },
  { target: "property.areaSqm", group: "Property", label: "Area (sqm)", dataType: "number", optional: true },
  { target: "property.description", group: "Property", label: "Property Description", dataType: "string", optional: true },
  { target: "property.titleText", group: "Property", label: "Title Text", dataType: "string", optional: true },
  { target: "property.lotNo", group: "Property", label: "Lot No", dataType: "string", optional: true },
  { target: "property.hakmilikNo", group: "Property", label: "Hakmilik No", dataType: "string", optional: true },

  { target: "financing.endFinancierBank", group: "Financing", label: "End Financier Bank", dataType: "string", optional: true },
  { target: "financing.bankRef", group: "Financing", label: "Bank Reference", dataType: "string", optional: true },
  { target: "financing.branchAddressRaw", group: "Financing", label: "Bank Branch Address", dataType: "string", optional: true },
  { target: "financing.propertyFinancingSum", group: "Financing", label: "Property Financing Sum", dataType: "number", optional: true },
  { target: "financing.mrtaMrttRaw", group: "Financing", label: "MRTA/MRTT", dataType: "string", optional: true },
  { target: "financing.loanAmount", group: "Financing", label: "Total Loan Amount", dataType: "number", optional: true },

  { target: "keydate.spa_date", group: "Existing Dates / Milestones", label: "SPA Date", dataType: "date", optional: true },
  { target: "keydate.spa_stamped_date", group: "Existing Dates / Milestones", label: "SPA Stamped Date", dataType: "date", optional: true },
  { target: "keydate.letter_of_offer_date", group: "Existing Dates / Milestones", label: "Letter of Offer Date", dataType: "date", optional: true },
  { target: "keydate.loan_docs_signed_date", group: "Existing Dates / Milestones", label: "Loan Docs Signed Date", dataType: "date", optional: true },
  { target: "keydate.completion_date", group: "Existing Dates / Milestones", label: "Completion Date", dataType: "date", optional: true },

  { target: "IGNORE", group: "Other", label: "Ignore Column", dataType: "string", description: "Do not import this column" },
  { target: "LEGACY_SNAPSHOT_ONLY", group: "Other", label: "Snapshot Only", dataType: "string", description: "Keep in raw snapshot only" },
];

export const M_LEGASI_PRESET_MAPPING: Record<string, FieldMappingTargetType> = {
  "our ref": "case.referenceNo",
  "parcel no": "case.parcelNo",
  "purchaser 1": "purchaser.name",
  "purchaser 1 ic / company no": "purchaser.ic",
  "purchaser 1 ic": "purchaser.ic",
  "purchaser 2": "purchaser.name",
  "purchaser 2 ic": "purchaser.ic",
  "purchaser 3": "purchaser.name",
  "purchaser 3 ic": "purchaser.ic",
  "purchaser 4": "purchaser.name",
  "purchaser 4 ic": "purchaser.ic",
  "address": "purchaser.address",
  "contact number": "purchaser.phone",
  "email address": "purchaser.email",
  "address line 1": "purchaser.addressLine1",
  "address line 2": "purchaser.addressLine2",
  "address line 3": "purchaser.addressLine3",
  "address line 4": "purchaser.addressLine4",
  "address line 5": "purchaser.addressLine5",
  "borrower 1": "borrower.name",
  "borrower 1 ic": "borrower.ic",
  "borrower 2": "borrower.name",
  "borrower 2 ic": "borrower.ic",
  "borrower 3": "borrower.name",
  "borrower 3 ic": "borrower.ic",
  "borrower 4": "borrower.name",
  "borrower 4 ic": "borrower.ic",
  "type": "property.propertyType",
  "area of parcel (sqm)": "property.areaSqm",
  "property": "property.description",
  "title": "property.titleText",
  "purchase price": "case.spaPrice",
  "developer": "IGNORE",
  "dev co reg": "IGNORE",
  "sol in charge": "IGNORE",
  "end financier": "financing.endFinancierBank",
  "bank ref.": "financing.bankRef",
  "bank branch address": "financing.branchAddressRaw",
  "property financing sum": "financing.propertyFinancingSum",
  "mrta/mrtt": "financing.mrtaMrttRaw",
  "total loan": "financing.loanAmount",
  "spa date": "keydate.spa_date",
  "spa stamping": "keydate.spa_stamped_date",
  "lo date": "keydate.letter_of_offer_date",
};
