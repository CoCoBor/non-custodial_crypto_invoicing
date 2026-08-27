import { ObjectId } from "mongodb";


declare global{
    namespace Express{
        interface Request{
            session?:{
                sessionId: ObjectId
                accountId: ObjectId
                expiresAt: Date
            }
        }
    }
}