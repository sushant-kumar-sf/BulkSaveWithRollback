import saveAccountRecords from "@salesforce/apex/RecordSaveController.saveAccountRecords";
import saveContactRecords from "@salesforce/apex/RecordSaveController.saveContactRecords";

const ACCOUNT_TYPE = "ADvendio__Campaign_Item__c";
const CONTACT_TYPE = "Campaign_Item_SKU__c";
const INSERT = "insert";
const UPDATE = "update";
const DELETE = "delete";
const UNDELETE = "undelete";

// Record get processed in configured order. Here Contact will be first processed then Account
const OBJECT_CONFIGS = [
    { sObjectType: CONTACT_TYPE, client: getSFClient(saveContactRecords), chunkSize: 8000 },
    { sObjectType: ACCOUNT_TYPE, client: getSFClient(saveAccountRecords), chunkSize: 100 }
];

async function saveMixedObjectTypesWithRollback(data = {}) {
    let result = { success: true, error: null, rollbackResults: {} };

    try {
        await saveRecordsForAllObjects(data);
    } catch (error) {
        console.error("❌ Error during processing");

        try {
            result.rollbackResults = await rollbackForAllObjects(data);
        } catch (error) {
            console.error("🔥 Rollback failed:", error.message);
        }
        result.success = false;
        result.error = error;
    }

    return result;
}

async function saveRecordsForAllObjects(data) {
    for (const objectConfig of OBJECT_CONFIGS) {
        if (!data[objectConfig.sObjectType]) continue;

        Object.assign(data[objectConfig.sObjectType], objectConfig);
        data[objectConfig.sObjectType].processed = {};

        await saveRecords(data[objectConfig.sObjectType]);
    }
    console.log("✔️ All operations completed successfully.");
}

async function rollbackForAllObjects(data) {
    let rollbackResults = {};
    for (const objectConfig of OBJECT_CONFIGS) {
        if (!data[objectConfig.sObjectType]) continue;
        if (!hasSomeProcessing(data[objectConfig.sObjectType].processed)) continue;

        rollbackResults[objectConfig.sObjectType] = await rollbackChanges(data[objectConfig.sObjectType]);
    }
    console.log("✔️ Rollback completed for all SObjects.");
    return rollbackResults;
}

function getSFClient(saveFunction) {
    let sfClient = {};

    sfClient.create = async function (chunk) {
        if (chunk.length === 0) return [];
        return await saveFunction({ records: chunk, actionType: INSERT });
    };

    sfClient.update = async function (chunk) {
        if (chunk.length === 0) return;
        await saveFunction({ records: chunk, actionType: UPDATE });
    };

    sfClient.delete = async function (chunk) {
        if (chunk.length === 0) return;
        await saveFunction({ records: chunk, actionType: DELETE });
    };

    sfClient.undelete = async function (chunk) {
        if (chunk.length === 0) return;
        await saveFunction({ records: chunk, actionType: UNDELETE });
    };

    return sfClient;
}

function hasSomeProcessing(processed = {}) {
    return (processed.created || []).length > 0 || (processed.updated || []).length > 0 || (processed.deleted || []).length > 0;
}

async function saveRecords({ newRecords = [], deletedRecords = [], processed, chunkSize, client, sObjectType }) {
    const { toInsert, toUpdate, toDelete } = classifyRecords(newRecords, deletedRecords);
    console.log(`Saving Records to Database [${sObjectType}]: Insert: ${toInsert.length}, Update: ${toUpdate.length}, Delete: ${toDelete.length}`);

    processed.created = [];
    processed.updated = [];
    processed.deleted = [];

    await insertRecords(toInsert, client, chunkSize, processed.created);
    await updateRecords(toUpdate, client, chunkSize, processed.updated);
    await deleteRecords(toDelete, client, chunkSize, processed.deleted);
}

function classifyRecords(newRecords, deletedRecords) {
    const toInsert = newRecords.filter((r) => !r.Id);
    const toUpdate = newRecords.filter((r) => r.Id);
    const toDelete = deletedRecords;
    return { toInsert, toUpdate, toDelete };
}

function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

async function insertRecords(records, client, chunkSize, createdRecords) {
    for (const chunk of chunkArray(records, chunkSize)) {
        const res = await client.create(chunk);
        createdRecords.push(...res);
        console.log(`Insert Processed: ${createdRecords.length} of ${records.length} records.`);
    }
}

async function updateRecords(records, client, chunkSize, updatedRecords) {
    for (const chunk of chunkArray(records, chunkSize)) {
        await client.update(chunk);
        updatedRecords.push(...chunk);
        console.log(`Update Processed: ${updatedRecords.length} of ${records.length} records.`);
    }
}

async function deleteRecords(records, client, chunkSize, deletedRecords) {
    for (const chunk of chunkArray(records, chunkSize)) {
        await client.delete(chunk);
        deletedRecords.push(...chunk);
        console.log(`Delete Processed: ${deletedRecords.length} of ${records.length} records.`);
    }
}

async function rollbackChanges(rollBackRequest) {
    const rollbackResult = { failedToDelete: [], failedToUpdate: [], failedToUndelete: [] };
    const { processed, oldRecords, deletedRecords, client, chunkSize, sObjectType } = rollBackRequest;

    console.log(`⚠️ Starting Rollback for ${sObjectType}`);

    rollbackResult.failedToDelete = await rollbackInserted(processed.created, client, chunkSize);
    rollbackResult.failedToUpdate = await rollbackUpdated(processed.updated, oldRecords, client, chunkSize);
    rollbackResult.failedToUndelete = await rollbackBackDeleted(processed.deleted, deletedRecords, client, chunkSize);

    console.log(`✔️ Rollback completed for ${sObjectType}`);
    return rollbackResult;
}

async function rollbackInserted(created, client, chunkSize) {
    const insertedIds = created.map((r) => ({ Id: r.Id }));
    return await rollbackAction(insertedIds, client.delete, chunkSize, "Deleting Created");
}

async function rollbackUpdated(updated, oldRecords, client, chunkSize) {
    const oldMap = new Map(oldRecords.map((r) => [r.Id, r]));
    const rollbackUpdates = updated.map((r) => oldMap.get(r.Id)).filter(Boolean);
    return await rollbackAction(rollbackUpdates, client.update, chunkSize, "Reverting Updated");
}

async function rollbackBackDeleted(processedDeleted, deletedRecords, client, chunkSize) {
    const processedDeletedIds = new Set([...processedDeleted.map((r) => r.Id)]);
    const deletedOldRecords = deletedRecords.filter((r) => processedDeletedIds.has(r.Id));
    return await rollbackAction(deletedOldRecords, client.undelete, chunkSize, "Undeleting Deleted");
}

async function rollbackAction(records, actionFn, chunkSize, label) {
    const failed = [];
    let counter = 0;

    for (const chunk of chunkArray(records, chunkSize)) {
        try {
            await actionFn(chunk);
            counter += chunk.length;
            console.log(`↩️ ${label} [Rollback]: ${counter} / ${records.length} Completed.`);
        } catch {
            failed.push(...chunk);
            console.warn(`⚠️ ${label} rollback failed for ${chunk.length} records.`);
        }
    }

    return failed;
}

export { saveMixedObjectTypesWithRollback };
