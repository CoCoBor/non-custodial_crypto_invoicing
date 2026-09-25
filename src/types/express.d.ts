import { ObjectId } from "mongodb";
import type { UserData } from "../database/users.model.js";

declare global{
    namespace Express{
        interface Request{
            session?:{
                sessionId: string
                userId: string
                expiresAt: Date
            }
            merchant?: Pick<UserData,"user_id"|"merchant_fee"|"payout_addresses">
        }
    }
}