import { Db, ObjectId } from "mongodb";

export interface CreatedAccount{
    accountId: ObjectId
    accountNumber: string
    mnemonic: string

}
