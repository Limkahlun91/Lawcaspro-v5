export type TitleCategory = "master" | "strata" | "individual";
export type PurchaseMode = "cash" | "loan" | "other";
export type LoanPartyType = "1st_party" | "3rd_party";
export type CaseType = "developer_sales" | "subsale" | "perfection";
export type LandCondition = "freehold" | "leasehold";
export type Encumbrances = "no_encumbrance" | "has_encumbrance" | "to_confirm";
export type ActingFor = "vendor" | "purchaser" | "both";
export type PerfectionType = "transfer_and_charge" | "transfer" | "charge";

export type AddressLines = {
  line1: string;
  line2: string;
  line3: string;
  line4: string;
  line5: string;
};

export type PurchaserForm = {
  id: string;
  isCompany: boolean;
  name: string;
  icOrCompanyNo: string;
  tin: string;
  tel: string;
  email: string;
  postcode: string;
  city: string;
  state: string;
  addressLines: AddressLines;
  address: string;
};

export type BorrowerForm = {
  id: string;
  name: string;
  ic: string;
  tin: string;
  hp: string;
  email: string;
  postcode: string;
  city: string;
  state: string;
  addressLines: AddressLines;
  address: string;
  addressLine1?: string;
  addressLine2?: string;
  addressLine3?: string;
  addressLine4?: string;
  addressLine5?: string;
};

export type CaseFormValues = {
  caseType: CaseType | "";
  projectId: string;
  developerId: string;
  titleCategory: TitleCategory | "";
  purchaseMode: PurchaseMode;
  landCondition: LandCondition | "";
  encumbrances: Encumbrances | "";
  actingFor: ActingFor | "";
  perfectionType: PerfectionType | "";

  purchasers: PurchaserForm[];

  loanPartyType: LoanPartyType;
  borrowers: BorrowerForm[];
  endFinancierBank: string;
  bankRef: string;
  branch: string;
  branchAddressLines: AddressLines;
  branchAddress: string;
  financingSum: string;
  othersSum: string;

  property: {
    titleTypeLabel: string;
    lotNo: string;
    hakmilikNo: string;
    bangunanNo: string;
    tingkatNo: string;
    petakNo: string;
    accessoryPetakNo: string;
    carparkNo: string;
    carparkLevel: string;
    landArea: string;
    accessoryArea: string;
    parcelNo: string;
    unitNo: string;
    buildingNo: string;
    floorNo: string;
    propertyType: string;
    areaSqm: string;
    bandarMukim: string;
    daerah: string;
    negeri: string;
    postcode: string;
    progressPayment: string;
    propertyAddressLines: AddressLines;
    propertyAddress: string;
  };

  apdlPrice: string;
  developerDiscount: string;
  bumiputraDiscount: string;
  purchasePrice: string;
};

