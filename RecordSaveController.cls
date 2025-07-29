public with sharing class RecordSaveController {

    @AuraEnabled
    public static List<Account> saveAccountRecords(List<Account> records, String actionType) {
        SavePoint sp = Database.setSavepoint();
        try {
            if (actionType == 'update') update records;
            else if (actionType == 'delete') delete records;
            else if (actionType == 'undelete') undelete records;
            else if (actionType == 'insert') insert records;
            else throw new AuraHandledException('Action not defined');
            return records;
        } catch (Exception ex) {
            Database.rollback(sp);
            throw new AuraHandledException(ex.getMessage());
        }
    }


    @AuraEnabled
    public static List<Account> saveContactRecords(List<Contact> records, String actionType) {
        SavePoint sp = Database.setSavepoint();
        try {
            if (actionType == 'update') update records;
            else if (actionType == 'delete') delete records;
            else if (actionType == 'undelete') undelete records;
            else if (actionType == 'insert') insert records;
            else throw new AuraHandledException('Action not defined');
            return records;
        } catch (Exception ex) {
            Database.rollback(sp);
            throw new AuraHandledException(ex.getMessage());
        }
    }
}