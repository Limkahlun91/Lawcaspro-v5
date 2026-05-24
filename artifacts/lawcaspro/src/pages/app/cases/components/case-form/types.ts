export type TitleCategory = "master" | "strata" | "individual";
export type PurchaseMode = "cash" | "loan" | "other";
export type LoanPartyType = "1st_party" | "3rd_party";

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
  tel: string;
  email: string;
  addressLines: AddressLines;
  address: string;
};

export type BorrowerForm = {
  id: string;
  name: string;
  ic: string;
  hp: string;
  email: string;
  addressLines: AddressLines;
  address: string;
};

export type CaseFormValues = {
  referenceNo: string;
  projectId: string;
  developerId: string;
  titleCategory: TitleCategory | "";
  purchaseMode: PurchaseMode;

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
    propertyAddressLines: AddressLines;
    propertyAddress: string;
  };

  apdlPrice: string;
  developerDiscount: string;
  bumiputraDiscount: string;
  purchasePrice: string;
};

