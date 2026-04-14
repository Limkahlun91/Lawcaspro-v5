export interface WorkflowStepDef {
  stepKey: string;
  stepName: string;
  stepOrder: number;
  pathType: string;
}

function getCommonSteps(): WorkflowStepDef[] {
  return [
    { stepKey: "file_opened", stepName: "File Opened / SPA Pending Signing", stepOrder: 1, pathType: "common" },
    { stepKey: "spa_stamped", stepName: "SPA Stamped", stepOrder: 2, pathType: "common" },
    { stepKey: "lof_stamped", stepName: "Letter of Offer Stamped", stepOrder: 3, pathType: "common" },
  ];
}

function getLoanSteps(): WorkflowStepDef[] {
  return [
    { stepKey: "loan_docs_pending", stepName: "Loan Docs Pending Signing", stepOrder: 4, pathType: "loan" },
    { stepKey: "loan_docs_signed", stepName: "Loan Docs Signed", stepOrder: 5, pathType: "loan" },
    { stepKey: "acting_letter_pending", stepName: "Acting Letter Pending", stepOrder: 6, pathType: "loan" },
    { stepKey: "acting_letter_issued", stepName: "Acting Letter Issued", stepOrder: 7, pathType: "loan" },
    { stepKey: "loan_pending_bank_exec", stepName: "Loan Doc. Pending Bank Execution", stepOrder: 8, pathType: "loan" },
    { stepKey: "loan_sent_bank_exec", stepName: "Loan Doc. Sent for Bank Execution", stepOrder: 9, pathType: "loan" },
    { stepKey: "loan_bank_executed", stepName: "Loan Doc. Bank Executed", stepOrder: 10, pathType: "loan" },
    { stepKey: "blu_received", stepName: "Bank Letter of Undertaking Received", stepOrder: 11, pathType: "loan" },
    { stepKey: "blu_confirmed", stepName: "Bank's Letter of Undertaking", stepOrder: 12, pathType: "loan" },
  ];
}

function getMotSteps(): WorkflowStepDef[] {
  return [
    { stepKey: "mot_pending", stepName: "Pending MOT From Developer", stepOrder: 13, pathType: "mot" },
    { stepKey: "mot_received", stepName: "MOT Executed & Received", stepOrder: 14, pathType: "mot" },
    { stepKey: "mot_invoice_prepare", stepName: "To Prepare Invoice for MOT Stamp Duty & Registration", stepOrder: 15, pathType: "mot" },
    { stepKey: "mot_stamp_received", stepName: "MOT Stamp Duty & Registration Received", stepOrder: 16, pathType: "mot" },
    { stepKey: "mot_submitted_stamping", stepName: "MOT Dated & Submitted Stamping", stepOrder: 17, pathType: "mot" },
    { stepKey: "mot_stamp", stepName: "MOT Stamp", stepOrder: 18, pathType: "mot" },
  ];
}

function getNoaPaSteps(): WorkflowStepDef[] {
  return [
    { stepKey: "noa_prepare", stepName: "To Prepare Notice of Assignment (NOA)", stepOrder: 13, pathType: "noa_pa" },
    { stepKey: "noa_served", stepName: "NOA Served", stepOrder: 14, pathType: "noa_pa" },
    { stepKey: "pa_pending", stepName: "Pending Register Power of Attorney (PA)", stepOrder: 15, pathType: "noa_pa" },
    { stepKey: "pa_registered", stepName: "Power of Attorney Registered", stepOrder: 16, pathType: "noa_pa" },
    { stepKey: "letter_disclaimer", stepName: "Letter Disclaimer", stepOrder: 17, pathType: "noa_pa" },
  ];
}

export function buildWorkflowSteps(purchaseMode: string, titleType: string): WorkflowStepDef[] {
  const steps: WorkflowStepDef[] = [...getCommonSteps()];

  if (purchaseMode === "loan") {
    steps.push(...getLoanSteps());
  }

  if (titleType === "individual" || titleType === "strata") {
    steps.push(...getMotSteps());
  } else {
    steps.push(...getNoaPaSteps());
  }

  return steps;
}
